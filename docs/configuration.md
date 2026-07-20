# Configuration guide

The accelerator is configured through three surfaces: **environment variables** that wire the agent to Azure, the **pedagogy policy** that governs tutoring behavior, and the **toolbox definition** that governs knowledge access.

## Environment variables

The agent reads these settings at startup. Each has a safe default so the app runs locally, but production deployments should set them explicitly.

| Variable | Purpose | Example |
| --- | --- | --- |
| `FOUNDRY_PROJECT_ENDPOINT` | Foundry project endpoint for the hosted agent runtime | `https://<resource>.services.ai.azure.com/api/projects/<project>` |
| `TOOLBOX_ENDPOINT` | MCP endpoint for the Foundry Toolbox | `https://<resource>.services.ai.azure.com/.../toolboxes/homework-toolbox/mcp?api-version=v1` |
| `AZURE_AI_MODEL_DEPLOYMENT_NAME` | Model deployment the agent invokes | `gpt-4o` |
| `PEDAGOGY_POLICY_URI` | Location of the pedagogy JSON policy | `./Pedagogy/pedagogy-policy.json` |

A starter template is available in [../src/HomeworkAgent/.env.example](../src/HomeworkAgent/.env.example). The deployment scripts also set these values into the Azure Developer CLI environment — see [../scripts/README.md](../scripts/README.md).

## Pedagogy policy

The policy is a small JSON document loaded at request time, so changes take effect without redeploying the agent. The schema is defined by [../src/HomeworkAgent/Pedagogy/PedagogyPolicy.cs](../src/HomeworkAgent/Pedagogy/PedagogyPolicy.cs).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `helpLevel` | string | `guided` | `hint_only`, `guided`, `worked_example`, or `full_solution` |
| `maxStepsRevealed` | number | `3` | How much of a solution the tutor may expose at once |
| `allowDirectAnswers` | boolean | `false` | Whether a direct solution is ever permitted |
| `citationsRequired` | boolean | `true` | Whether responses must cite retrieved sources |
| `subjectOverrides` | object | `{}` | Per-subject help-level overrides layered on the defaults |
| `refusalMessage` | string | provided | Shown when the tutor declines to solve graded work outright |
| `escalationMessage` | string | provided | Nudges the student toward a more specific ask |

**Example policy:**

```json
{
  "helpLevel": "guided",
  "maxStepsRevealed": 3,
  "allowDirectAnswers": false,
  "citationsRequired": true,
  "subjectOverrides": {
    "math": "guided",
    "science": "hint_only"
  }
}
```

The default policy lives in [../src/HomeworkAgent/Pedagogy/pedagogy-policy.json](../src/HomeworkAgent/Pedagogy/pedagogy-policy.json). The professor portal reads and writes this same document through its API, so UI edits and file edits stay in sync.

### How the policy is applied

At request time the agent loads the policy and the prompt composer injects it directly into the system prompt ([../src/HomeworkAgent/PromptComposer.cs](../src/HomeworkAgent/PromptComposer.cs)). The model therefore sees the guardrails on every turn, which keeps behavior consistent across requests.

## Knowledge sources

Knowledge access is defined in [../toolbox/toolbox.yaml](../toolbox/toolbox.yaml). Each tool points at one or more Azure AI Search indexes and specifies how they are queried (for example, `vector_semantic_hybrid` with a `top_k` limit).

To add a new source:

1. Add the Azure AI Search connection details to the toolbox definition.
2. Add the index to the tool's `indexes` list.
3. Publish a new toolbox version through the professor portal workflow.
4. Keep the consumer endpoint stable so the agent does not need to be redeployed.

Because all knowledge flows through the toolbox, adding or removing a source is a governed, auditable change rather than an agent code change. See [../config/knowledge-sources.md](../config/knowledge-sources.md) for guidance on managing multiple sources and versions.
