using Azure.AI.Projects;
using Azure.Identity;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Foundry.Hosting;
using Microsoft.Agents.AI.Hosting.AGUI.AspNetCore;
using Microsoft.Extensions.AI;

var builder = WebApplication.CreateBuilder(args);

// --- Configuration -------------------------------------------------------
var projectEndpoint = Environment.GetEnvironmentVariable("FOUNDRY_PROJECT_ENDPOINT");
var modelDeployment = Environment.GetEnvironmentVariable("AZURE_AI_MODEL_DEPLOYMENT_NAME") ?? "gpt-4o";
var pedagogyPolicyUri = Environment.GetEnvironmentVariable("PEDAGOGY_POLICY_URI");
// Azure AI Search knowledge base that grounds the tutor in approved course
// material. When SEARCH_ENDPOINT is set (wired by infra after the KB is seeded),
// the agent gets a retrieval tool; otherwise it runs ungrounded (local dev).
var searchEndpoint = Environment.GetEnvironmentVariable("SEARCH_ENDPOINT");
var knowledgeBaseName = Environment.GetEnvironmentVariable("KNOWLEDGE_BASE_NAME") ?? "course-knowledge-base";
var knowledgeSourceName = Environment.GetEnvironmentVariable("KNOWLEDGE_SOURCE_NAME") ?? "course-materials-source";
// Comma-separated list of origins allowed to call the AG-UI endpoint from a browser
// (e.g. the CopilotKit frontend / LTI tool). Defaults to any origin for local dev.
var allowedOrigins = (Environment.GetEnvironmentVariable("ALLOWED_ORIGINS") ?? "*")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

// Tutor persona = base system prompt + the professor-managed pedagogy policy.
var policyPath = PolicyStore.ResolvePath(pedagogyPolicyUri);
var policy = await PedagogyPolicy.LoadAsync(policyPath);
var systemPromptPath = Path.Combine(AppContext.BaseDirectory, "instructions", "tutor-system-prompt.md");
var systemPrompt = File.Exists(systemPromptPath)
    ? await File.ReadAllTextAsync(systemPromptPath)
    : "You are a homework tutor. Prefer hints and guiding questions over direct answers.";
var instructions = PromptComposer.Compose(systemPrompt, policy);

// CORS so a browser-hosted CopilotKit UI can reach the AG-UI SSE endpoint.
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(p =>
    {
        if (allowedOrigins.Length == 1 && allowedOrigins[0] == "*")
        {
            p.AllowAnyOrigin();
        }
        else
        {
            p.WithOrigins(allowedOrigins).AllowCredentials();
        }
        p.AllowAnyHeader().AllowAnyMethod();
    });
});

builder.Services.AddAGUIServer();

var app = builder.Build();
app.UseCors();

app.MapGet("/health", () => Results.Ok(new
{
    status = "ok",
    model = modelDeployment,
    hasProjectEndpoint = !string.IsNullOrWhiteSpace(projectEndpoint),
    grounded = !string.IsNullOrWhiteSpace(searchEndpoint)
}));

if (string.IsNullOrWhiteSpace(projectEndpoint))
{
    // Keep /health up for probes, but make the missing-config failure explicit.
    app.MapPost("/", () => Results.Problem(
        "FOUNDRY_PROJECT_ENDPOINT is not configured; the tutor agent is offline.",
        statusCode: StatusCodes.Status503ServiceUnavailable));
}
else
{
    var credential = new DefaultAzureCredential();

    // Ground the tutor in approved course material: expose the Azure AI Search
    // knowledge base as a function tool so the model retrieves and cites the
    // professor-approved corpus instead of its own training knowledge.
    var tools = new List<AITool>();
    if (!string.IsNullOrWhiteSpace(searchEndpoint))
    {
        var knowledgeBase = new KnowledgeBase(searchEndpoint, knowledgeBaseName, knowledgeSourceName, credential);
        tools.Add(AIFunctionFactory.Create(knowledgeBase.SearchCourseMaterials));
    }

    // Real Microsoft Agent Framework agent backed by a Foundry model. The framework
    // manages the LLM call, conversation history, tool invocation, and lifecycle.
    AIAgent agent = new AIProjectClient(new Uri(projectEndpoint), credential)
        .AsAIAgent(
            model: modelDeployment,
            instructions: instructions,
            name: "homework-tutor",
            description: "An EDU homework tutor that gives guided, pedagogy-aware support grounded in approved course knowledge.",
            tools: tools);

    // Expose the agent over the AG-UI protocol (SSE) for CopilotKit / AG-UI clients.
    app.MapAGUIServer("/", agent);
}

app.Run();
