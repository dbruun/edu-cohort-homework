// Copyright (c) Microsoft. All rights reserved.

/*
 * EDU Homework Tutor — Agent Framework Responses agent for C#
 *
 * Hosted agent that uses the Microsoft Agent Framework (Microsoft.Agents.AI) to create an
 * AIAgent backed by a Foundry model, then hosts it with AgentHost.CreateBuilder() from
 * Azure.AI.AgentServer.Core using AddFoundryResponses from Microsoft.Agents.AI.Foundry.Hosting.
 *
 * The agent framework manages the LLM call, conversation history, and response lifecycle.
 * The base tutor persona (instructions/tutor-system-prompt.md) is layered with the
 * professor-configurable pedagogy policy (Pedagogy/pedagogy-policy.json) via PromptComposer
 * to produce the agent's instructions at startup.
 *
 * Course knowledge is grounded through a Foundry Toolbox (an Azure AI Search index behind a
 * managed MCP proxy). AddFoundryToolboxes connects to that toolbox at startup, discovers its
 * tools, and injects them into every request — the Foundry platform brokers the tool calls,
 * so the agent never hard-codes or locally executes them. The toolbox is declared as a
 * host: azure.ai.toolbox service in azure.yaml.
 *
 * Required environment variables:
 *   FOUNDRY_PROJECT_ENDPOINT         — Foundry project endpoint (auto-injected in hosted containers)
 *   AZURE_AI_MODEL_DEPLOYMENT_NAME   — Model deployment name
 *   TOOLBOX_NAME                     — Name of the Foundry Toolbox to load (course knowledge)
 *
 * Optional environment variables:
 *   PEDAGOGY_POLICY_URI              — Path to the pedagogy policy JSON (defaults to Pedagogy/pedagogy-policy.json)
 *   COURSE_ID                        — Course whose group-specific policy limits apply
 */

#pragma warning disable OPENAI001 // Foundry Toolbox hosting APIs are experimental

using Azure.AI.Projects;
using Azure.Identity;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Foundry.Hosting;

var projectEndpoint = new Uri(Environment.GetEnvironmentVariable("FOUNDRY_PROJECT_ENDPOINT")
    ?? throw new InvalidOperationException("FOUNDRY_PROJECT_ENDPOINT environment variable is not set."));

var deployment = Environment.GetEnvironmentVariable("AZURE_AI_MODEL_DEPLOYMENT_NAME")
    ?? throw new InvalidOperationException("AZURE_AI_MODEL_DEPLOYMENT_NAME environment variable is not set.");

// Optional: name of the Foundry Toolbox that grounds answers in course knowledge (Azure AI
// Search). When unset/empty the tutor still runs, just without knowledge grounding.
var toolboxName = Environment.GetEnvironmentVariable("TOOLBOX_NAME");

var pedagogyPolicyUri = Environment.GetEnvironmentVariable("PEDAGOGY_POLICY_URI");
var courseId = Environment.GetEnvironmentVariable("COURSE_ID");

// Compose the agent instructions from the base tutor persona plus the professor-managed
// pedagogy policy. If the policy file is missing, PedagogyPolicy.LoadAsync returns defaults
// so the tutor always stays online.
var systemPrompt = await File.ReadAllTextAsync(
    Path.Combine(AppContext.BaseDirectory, "instructions", "tutor-system-prompt.md"));
var policy = await PolicyStore.LoadAsync(pedagogyPolicyUri);
policy = policy.ResolveForCourse(courseId);
var instructions = PromptComposer.Compose(systemPrompt, policy);

Console.WriteLine($"[INFO] Loaded pedagogy policy from '{pedagogyPolicyUri ?? "default"}' (courseId={courseId ?? "default"}, helpLevel={policy.HelpLevel}).");

// Create an AIAgent backed by a Foundry model. The agent framework manages the LLM call,
// conversation sessions, and response lifecycle.
AIAgent agent = new AIProjectClient(projectEndpoint, new DefaultAzureCredential())
    .AsAIAgent(
        model: deployment,
        instructions: instructions,
        name: "homework-tutor",
        description: "An EDU homework tutor that gives guided, pedagogy-aware support grounded in approved course knowledge.");

// AgentHost.CreateBuilder() auto-configures Kestrel (port 8088 or the PORT env var), the
// GET /readiness health probe, OpenTelemetry traces/metrics, and the responses protocol.
var builder = AgentHost.CreateBuilder(args);
builder.Services.AddFoundryResponses(agent);

// Register the course-knowledge Foundry Toolbox when configured. At startup the hosting layer
// connects to the toolbox's managed MCP proxy (derived from FOUNDRY_PROJECT_ENDPOINT), discovers
// its tools (the Azure AI Search course-search tool), and injects them into every request. Tool
// calls are brokered by the Foundry platform. Omitting a version resolves the toolbox's default.
// When TOOLBOX_NAME is unset the tutor runs without knowledge grounding.
if (!string.IsNullOrWhiteSpace(toolboxName))
{
    builder.Services.AddFoundryToolboxes(toolboxName);
    Console.WriteLine($"[INFO] Attached Foundry Toolbox '{toolboxName}' for course knowledge.");
}
else
{
    Console.WriteLine("[INFO] TOOLBOX_NAME not set — running without a knowledge toolbox.");
}

builder.RegisterProtocol("responses", endpoints => endpoints.MapFoundryResponses());

var app = builder.Build();
app.Run();
