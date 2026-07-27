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
 * to produce the agent's instructions at startup. The curated knowledge toolbox is attached
 * to the hosted agent at the Foundry platform level (see toolbox/toolbox.yaml).
 *
 * Required environment variables:
 *   FOUNDRY_PROJECT_ENDPOINT         — Foundry project endpoint (auto-injected in hosted containers)
 *   AZURE_AI_MODEL_DEPLOYMENT_NAME   — Model deployment name
 *
 * Optional environment variables:
 *   PEDAGOGY_POLICY_URI              — Path to the pedagogy policy JSON (defaults to Pedagogy/pedagogy-policy.json)
 */

using Azure.AI.Projects;
using Azure.Identity;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Foundry.Hosting;

var projectEndpoint = new Uri(Environment.GetEnvironmentVariable("FOUNDRY_PROJECT_ENDPOINT")
    ?? throw new InvalidOperationException("FOUNDRY_PROJECT_ENDPOINT environment variable is not set."));

var deployment = Environment.GetEnvironmentVariable("AZURE_AI_MODEL_DEPLOYMENT_NAME")
    ?? throw new InvalidOperationException("AZURE_AI_MODEL_DEPLOYMENT_NAME environment variable is not set.");

var pedagogyPolicyUri = Environment.GetEnvironmentVariable("PEDAGOGY_POLICY_URI");

// Compose the agent instructions from the base tutor persona plus the professor-managed
// pedagogy policy. If the policy file is missing, PedagogyPolicy.LoadAsync returns defaults
// so the tutor always stays online.
var systemPrompt = await File.ReadAllTextAsync(
    Path.Combine(AppContext.BaseDirectory, "instructions", "tutor-system-prompt.md"));
var policyPath = PolicyStore.ResolvePath(pedagogyPolicyUri);
var policy = await PedagogyPolicy.LoadAsync(policyPath);
var instructions = PromptComposer.Compose(systemPrompt, policy);

Console.WriteLine($"[INFO] Loaded pedagogy policy from '{policyPath}' (helpLevel={policy.HelpLevel}).");

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
builder.RegisterProtocol("responses", endpoints => endpoints.MapFoundryResponses());

var app = builder.Build();
app.Run();
