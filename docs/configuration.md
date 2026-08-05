# Configuration guide

The Phase 1 lab configures the tutor through
[agent instructions](https://github.com/dbruun/edu-cohort-homework/blob/main/lab/agent-instructions.md) in the Foundry portal and
attaches `course-knowledge-base` directly. The environment-variable, .NET policy,
and toolbox configuration below documents the later hosted-agent implementation;
it is not deployed by the current lab.

## Environment variables

The hosted agent's manifest ([azure.yaml](https://github.com/dbruun/edu-cohort-homework/blob/main/azure.yaml)) declares these. Foundry injects the project endpoint automatically at runtime.

| Variable | Purpose | Example |
| --- | --- | --- |
| `FOUNDRY_PROJECT_ENDPOINT` | Foundry project endpoint (auto-injected in the hosted container) | `https://<account>.services.ai.azure.com/api/projects/<project>` |
| `AZURE_AI_MODEL_DEPLOYMENT_NAME` | Model deployment the agent invokes | `gpt-5.4-mini` |
| `TOOLBOX_NAME` | Name of the Foundry Toolbox the agent loads for course knowledge | `course-knowledge` |
| `PEDAGOGY_POLICY_URI` | Local policy path or professor portal policy blob URL | `https://<account>.blob.core.windows.net/policies/<professor-id>.json` |
| `COURSE_ID` | Course ID used to select a configured course group | `CS101` |

The `scripts/deploy.*` scripts set `AZURE_AI_MODEL_DEPLOYMENT_NAME`, `PEDAGOGY_POLICY_URI`, `COURSE_ID`, and the subscription/location into the `azd` environment before deploy. Pass the configured course ID as the eighth positional argument and the portal policy blob URL as the ninth to `deploy.sh`, or use `-CourseId` and `-PedagogyPolicyUri` with `deploy.ps1`. The agent managed identity needs **Storage Blob Data Reader** on the portal's `policies` container — see [scripts/README.md](https://github.com/dbruun/edu-cohort-homework/blob/main/scripts/README.md).

> **Legacy note:** Older docs referenced a `TOOLBOX_ENDPOINT` URL variable. That belonged to an earlier self-hosted prototype; the hosted Foundry agent now loads its toolbox by name (`TOOLBOX_NAME`), so `TOOLBOX_ENDPOINT` is no longer used.

## Pedagogy policy

The policy is a small JSON document. Its schema matches [src/HomeworkAgent/Pedagogy/PedagogyPolicy.cs](https://github.com/dbruun/edu-cohort-homework/blob/main/src/HomeworkAgent/Pedagogy/PedagogyPolicy.cs), and the seed values live in [src/HomeworkAgent/Pedagogy/pedagogy-policy.json](https://github.com/dbruun/edu-cohort-homework/blob/main/src/HomeworkAgent/Pedagogy/pedagogy-policy.json).

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

Within a professor's pedagogy, **course groups** let one set of limits apply to many courses at once. Each course carries an `id` and a human-readable `description`. A course in a group uses that group's limits; any field the group leaves unset falls back to the professor's top-level defaults. Resolution is implemented in [src/HomeworkAgent/Pedagogy/PedagogyPolicy.cs](https://github.com/dbruun/edu-cohort-homework/blob/main/src/HomeworkAgent/Pedagogy/PedagogyPolicy.cs) (`PedagogyCatalog.ResolveForCourse` → `PedagogyPolicy.ResolveForCourse`).

### How the policy is applied

The pedagogy policy is composed into the hosted agent's instructions at startup in [src/HomeworkAgent/Program.cs](https://github.com/dbruun/edu-cohort-homework/blob/main/src/HomeworkAgent/Program.cs). Set `PEDAGOGY_POLICY_URI` to the professor portal's policy blob and `COURSE_ID` to one of its configured course IDs: the agent authenticates to the blob with its managed identity, resolves the matching course group's limits, and then builds its instructions. Because the policy is read when the container starts, **changing the policy takes effect on the next deploy/restart** (`azd deploy`). A live per-request read from external storage is not enabled in this environment — see the architecture doc for why.

## Knowledge sources

Course knowledge is grounded through an Azure AI Search **toolbox** declared as the `course-knowledge` `host: azure.ai.toolbox` service in [azure.yaml](https://github.com/dbruun/edu-cohort-homework/blob/main/azure.yaml) (a reference copy lives in [toolbox/toolbox.yaml](https://github.com/dbruun/edu-cohort-homework/blob/main/toolbox/toolbox.yaml)). It exposes a `course-search` tool over the `course-materials` index using `vector_semantic_hybrid` retrieval. The agent loads it by name (`TOOLBOX_NAME=course-knowledge`) via `AddFoundryToolboxes`. The tool references an existing `course-knowledge-connection` (`CognitiveSearch`) that must be created once before the first deploy — the [deploy scripts](https://github.com/dbruun/edu-cohort-homework/blob/main/scripts/README.md) create it when given a Search endpoint + admin key. Adding or swapping a source is a toolbox/connection change, not an agent change. See [config/knowledge-sources.md](https://github.com/dbruun/edu-cohort-homework/blob/main/config/knowledge-sources.md) for the source-management guidance.
