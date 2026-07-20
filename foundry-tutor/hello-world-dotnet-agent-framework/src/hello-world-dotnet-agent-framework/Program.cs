// Copyright (c) Microsoft. All rights reserved.

/*
 * Hello World — Agent Framework Responses agent for C#
 *
 * Minimal hosted agent that uses the Microsoft Agent Framework (Microsoft.Agents.AI)
 * to create an AIAgent backed by a Foundry model, then hosts it using AgentHost.CreateBuilder()
 * from Azure.AI.AgentServer.Core with AddFoundryResponses from Microsoft.Agents.AI.Foundry.Hosting.
 *
 * This sample demonstrates the simplest possible Agent Framework integration: the agent
 * framework manages the LLM call, conversation history, and response lifecycle automatically —
 * there is no ResponseHandler subclass to implement. AgentHost.CreateBuilder() handles the
 * HTTP contract, port binding, health probes, SSE lifecycle, and OpenTelemetry tracing.
 *
 * Multi-turn conversation works automatically: on each request the framework calls
 * GetHistoryAsync() internally to build the conversation history from prior turns.
 * Pass previous_response_id from one response as the input to the next call to maintain
 * conversation context. Locally, history is stored in-process (lost on restart); when
 * hosted by Foundry (FOUNDRY_HOSTING_ENVIRONMENT set), it uses durable server-side storage.
 *
 * Required environment variables:
 *   FOUNDRY_PROJECT_ENDPOINT  — Foundry project endpoint (auto-injected in hosted containers)
 *   AZURE_AI_MODEL_DEPLOYMENT_NAME     — Model deployment name (declared in agent.manifest.yaml)
 *
 * Usage:
 *   dotnet run
 *
 *   # Turn 1 — invoke the agent:
 *   curl -sS -X POST http://localhost:8088/responses \
 *     -H "Content-Type: application/json" \
 *     -d '{"input": "What is Microsoft Foundry?", "stream": false}' | jq .
 *
 *   # Turn 2 — follow up using the id from the previous response:
 *   curl -sS -X POST http://localhost:8088/responses \
 *     -H "Content-Type: application/json" \
 *     -d '{"input": "Can you summarize that?", "previous_response_id": "<id>", "stream": false}' | jq .
 */

using Azure.AI.AgentServer.Core;
using Azure.AI.Projects;
using Azure.Identity;
using Azure.Storage.Blobs;
using DotNetEnv;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Foundry.Hosting;

// Load environment variables from a .env file if present (for local development).
Env.NoClobber().TraversePath().Load();

if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("APPLICATIONINSIGHTS_CONNECTION_STRING")))
{
    Console.Error.WriteLine(
        "[WARNING] APPLICATIONINSIGHTS_CONNECTION_STRING not set — traces will not be sent " +
        "to Application Insights. Set it to enable local telemetry. " +
        "(This variable is auto-injected in hosted Foundry containers — do not declare it in agent.manifest.yaml.)");
}

var projectEndpoint = new Uri(Environment.GetEnvironmentVariable("FOUNDRY_PROJECT_ENDPOINT")
    ?? throw new InvalidOperationException("FOUNDRY_PROJECT_ENDPOINT environment variable is not set."));

var deployment = Environment.GetEnvironmentVariable("AZURE_AI_MODEL_DEPLOYMENT_NAME")
    ?? throw new InvalidOperationException("AZURE_AI_MODEL_DEPLOYMENT_NAME environment variable is not set.");

// Base tutor persona. The professor-configurable pedagogy policy (stored as a JSON blob and
// edited through the professor portal) is layered on top of this at startup.
const string baseInstructions = """
    You are a homework tutor for students. Your goal is to build understanding, not to hand out answers.

    Guidelines:
    - Prefer hints, guiding questions, and step-by-step explanations over direct solutions.
    - Reveal only a few steps at a time and check the student's understanding before continuing.
    - Do not provide a complete solution to graded work; if asked, explain what you can help with instead.
    - When you use course knowledge, cite the source and clearly label anything you are unsure about.
    - Keep responses supportive, concise, and educational.
    """;

// Pull the professor-managed pedagogy policy from blob storage. Authenticates with the
// hosted agent's managed identity (Storage Blob Data Reader). Falls back to the base persona
// if the policy is unavailable so the tutor always stays online.
// Rebuild marker: blob-auth-retest-1
var instructions = baseInstructions;
var policyBlobUrl = Environment.GetEnvironmentVariable("PEDAGOGY_POLICY_BLOB_URL");
if (!string.IsNullOrWhiteSpace(policyBlobUrl))
{
    try
    {
        var credential = new DefaultAzureCredential();
        try
        {
            var token = await credential.GetTokenAsync(
                new Azure.Core.TokenRequestContext(new[] { "https://storage.azure.com/.default" }));
            var payload = token.Token.Split('.')[1];
            payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
            var claims = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(payload.Replace('-', '+').Replace('_', '/')));
            var oidMatch = System.Text.RegularExpressions.Regex.Match(claims, "\"oid\":\"([^\"]+)\"");
            var appidMatch = System.Text.RegularExpressions.Regex.Match(claims, "\"appid\":\"([^\"]+)\"");
            Console.WriteLine($"[IDENTITY] Storage token acquired. oid={oidMatch.Groups[1].Value} appid={appidMatch.Groups[1].Value}");
        }
        catch (Exception idEx)
        {
            Console.Error.WriteLine($"[IDENTITY] Could not decode storage token: {idEx.Message}");
        }

        var blobClient = new BlobClient(new Uri(policyBlobUrl), credential);
        var download = await blobClient.DownloadContentAsync();
        var policyJson = download.Value.Content.ToString();
        instructions = baseInstructions
            + "\n\nActive pedagogy policy (set by the instructor — follow it strictly):\n"
            + policyJson;
        Console.WriteLine($"[INFO] Loaded pedagogy policy from blob storage ({policyJson.Length} chars).");
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[WARNING] Could not load pedagogy policy blob ({ex.Message}); using base persona.");
    }
}

// Create an AIAgent backed by a Foundry model.
// The agent framework manages the LLM call, conversation sessions, and response lifecycle.
AIAgent agent = new AIProjectClient(projectEndpoint, new DefaultAzureCredential())
    .AsAIAgent(
        model: deployment,
        instructions: instructions,
        name: "homework-tutor",
        description: "An EDU homework tutor that gives guided, pedagogy-aware support grounded in approved course knowledge.");

// AgentHost.CreateBuilder() auto-configures:
//   - Kestrel on port 8088 (or the PORT environment variable)
//   - GET /readiness health probe
//   - OpenTelemetry traces and metrics
//   - x-platform-server response header
var builder = AgentHost.CreateBuilder(args);
builder.Services.AddFoundryResponses(agent);
builder.RegisterProtocol("responses", endpoints => endpoints.MapFoundryResponses());

var app = builder.Build();
app.Run();
