# Configuration guide

The deployed hosted agent is configured through **environment variables** (declared in its Foundry manifest) and the **pedagogy policy** that shapes tutoring behavior. The **toolbox** is defined but not yet connected.

## Environment variables

The hosted agent's manifest ([../foundry-tutor/hello-world-dotnet-agent-framework/azure.yaml](../foundry-tutor/hello-world-dotnet-agent-framework/azure.yaml)) declares these. Foundry injects the project endpoint automatically at runtime.

| Variable | Purpose | Example |
| --- | --- | --- |
| `FOUNDRY_PROJECT_ENDPOINT` | Foundry project endpoint (auto-injected in the hosted container) | `https://<account>.services.ai.azure.com/api/projects/<project>` |
| `AZURE_AI_MODEL_DEPLOYMENT_NAME` | Model deployment the agent invokes | `gpt-5.4-mini` |

The `scripts/deploy.*` scripts set `AZURE_AI_MODEL_DEPLOYMENT_NAME` and the subscription/location into the `azd` environment before deploy — see [../scripts/README.md](../scripts/README.md).

> **Legacy note:** Older docs referenced `TOOLBOX_ENDPOINT` and `PEDAGOGY_POLICY_URI`. Those belonged to an earlier self-hosted prototype that has been replaced by the hosted Foundry agent and are no longer used.

## Pedagogy policy

The policy is a small JSON document. Its schema matches [../src/HomeworkAgent/Pedagogy/PedagogyPolicy.cs](../src/HomeworkAgent/Pedagogy/PedagogyPolicy.cs), and the seed values live in [../src/HomeworkAgent/Pedagogy/pedagogy-policy.json](../src/HomeworkAgent/Pedagogy/pedagogy-policy.json).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `helpLevel` | string | `guided` | `hint_only`, `guided`, `worked_example`, or `full_solution` |
| `maxStepsRevealed` | number | `3` | How much of a solution the tutor may expose at once |
| `allowDirectAnswers` | boolean | `false` | Whether a direct solution is ever permitted |
| `citationsRequired` | boolean | `true` | Whether responses must cite sources |
| `subjectOverrides` | object | `{}` | Per-subject help-level overrides |
| `refusalMessage` | string | provided | Shown when the tutor declines to solve graded work outright |
| `escalationMessage` | string | provided | Nudges the student toward a more specific ask |
| `professorId` / `professorName` | string | provided | Identify the professor who owns this pedagogy |
| `courseGroups` | array | `[]` | Named groups of courses that share the same limits |

**Example policy:**

```json
{
  "professorId": "prof-adams",
  "professorName": "Dr. Adams",
  "helpLevel": "guided",
  "maxStepsRevealed": 3,
  "allowDirectAnswers": false,
  "citationsRequired": true,
  "subjectOverrides": {
    "math": "guided",
    "science": "hint_only"
  },
  "courseGroups": [
    {
      "name": "Group 1 - Intro CS",
      "courses": [
        { "id": "CS101", "description": "Introduction to Programming" },
        { "id": "CS102", "description": "Data Structures and Algorithms" }
      ],
      "helpLevel": "hint_only",
      "maxStepsRevealed": 1
    }
  ]
}
```

### Professor ownership and course groups

Each pedagogy is **owned by a professor** (`professorId` / `professorName`). Because a student can take courses from multiple professors, the tutor resolves the pedagogy from whichever professor owns the course being asked about — so two students in the same session can be held to different rules set by different instructors.

Within a professor's pedagogy, **course groups** let one set of limits apply to many courses at once. Each course carries an `id` and a human-readable `description`. A course in a group uses that group's limits; any field the group leaves unset falls back to the professor's top-level defaults. Resolution is implemented in [../src/HomeworkAgent/Pedagogy/PedagogyPolicy.cs](../src/HomeworkAgent/Pedagogy/PedagogyPolicy.cs) (`PedagogyCatalog.ResolveForCourse` → `PedagogyPolicy.ResolveForCourse`).

### How the policy is applied

Today the pedagogy guidance is written into the hosted agent's instructions in [../foundry-tutor/hello-world-dotnet-agent-framework/src/hello-world-dotnet-agent-framework/Program.cs](../foundry-tutor/hello-world-dotnet-agent-framework/src/hello-world-dotnet-agent-framework/Program.cs). Because it is compiled into the agent, **changing the policy requires editing it and redeploying the agent** (`azd deploy`). A live per-request read from external storage is not enabled in this environment — see the architecture doc for why.

## Knowledge sources (planned)

The toolbox in [../toolbox/toolbox.yaml](../toolbox/toolbox.yaml) describes the intended Azure AI Search access (indexes and query type such as `vector_semantic_hybrid`). It is **not yet connected** to the deployed agent. When wired up, adding a source would be a toolbox/connection change. See [../config/knowledge-sources.md](../config/knowledge-sources.md) for the source-management guidance.
