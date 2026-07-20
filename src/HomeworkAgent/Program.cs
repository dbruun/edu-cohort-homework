using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var projectEndpoint = Environment.GetEnvironmentVariable("FOUNDRY_PROJECT_ENDPOINT") ?? "https://example.services.ai.azure.com/api/projects/demo";
var toolboxEndpoint = Environment.GetEnvironmentVariable("TOOLBOX_ENDPOINT") ?? "https://example.services.ai.azure.com/api/projects/demo/toolboxes/homework-toolbox/mcp?api-version=v1";
var modelDeployment = Environment.GetEnvironmentVariable("AZURE_AI_MODEL_DEPLOYMENT_NAME") ?? "gpt-4o";
var pedagogyPolicyUri = Environment.GetEnvironmentVariable("PEDAGOGY_POLICY_URI") ?? "./Pedagogy/pedagogy-policy.json";
var policyPath = PolicyStore.ResolvePath(pedagogyPolicyUri);

app.MapGet("/health", () => Results.Ok(new { status = "ok", projectEndpoint, toolboxEndpoint, modelDeployment, policyPath }));

app.MapPost("/chat", async (ChatRequest request) =>
{
    var policy = await PedagogyPolicy.LoadAsync(policyPath);
    var systemPrompt = await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "instructions", "tutor-system-prompt.md"));
    var prompt = PromptComposer.Compose(systemPrompt, policy);

    var payload = new
    {
        model = modelDeployment,
        input = new[]
        {
            new { role = "system", content = prompt },
            new { role = "user", content = request.Message }
        },
        tools = new[]
        {
            new { type = "mcp", server_url = toolboxEndpoint }
        }
    };

    using var httpClient = new HttpClient();
    httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", await GetTokenAsync());
    httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

    var response = await httpClient.PostAsync(projectEndpoint + "/openai/responses?api-version=preview", new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json"));
    var body = await response.Content.ReadAsStringAsync();

    if (!response.IsSuccessStatusCode)
    {
        return Results.Problem(body, statusCode: (int)response.StatusCode);
    }

    return Results.Ok(new { response = body, policy, toolboxEndpoint });
});

app.Run();

static async Task<string> GetTokenAsync()
{
    return await Task.FromResult("demo-token");
}

public sealed class ChatRequest
{
    public string Message { get; init; } = string.Empty;
}
