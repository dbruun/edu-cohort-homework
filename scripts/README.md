# Deployment scripts

These scripts deploy the **EDU Homework Tutor** as a hosted agent on Microsoft Foundry
using the Azure Developer CLI (`azd`). They are turnkey: a new user who has never
touched this project can run one command and get a working, deployed agent.

## What they do

1. Check you're logged in (`az account show`) and capture the subscription + tenant.
2. Install the required `azd` Foundry extensions (`azure.ai.agents`, `azure.ai.toolboxes`, and dependencies).
3. Create/select an `azd` environment (this also names the resource group `rg-<env>`).
4. Set the subscription, tenant, region, model deployment name, pedagogy policy path, and toolbox name.
5. **New project:** provision the Foundry project + model (`azd provision`).
   **Existing project** (`-ProjectEndpoint` / 4th bash arg): resolve the project ARM ID + resource group and skip provisioning.
6. Optionally create the `course-knowledge-connection` (Azure AI Search) when a toolbox name + Search creds are supplied.
7. Deploy the `homework-agent` (`azd deploy homework-agent`).
8. Run a smoke-test invocation.

> The scripts deploy the repo-root [`azure.yaml`](../azure.yaml), which wires the `ai-project`
> model and the `src/HomeworkAgent` hosted agent (pedagogy composed from
> `Pedagogy/pedagogy-policy.json`). The Azure AI Search **toolbox is commented out by default**
> so a first deploy needs no Search resources — see [Enabling course knowledge](#enabling-course-knowledge).

## Prerequisites

- [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) **1.28+**
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- .NET 10 SDK
- Log in first: `az login` and `azd auth login` (tokens expire — re-run both if a deploy reports "Login expired").
- A model deployment matching `ModelDeploymentName` must exist (or, for a new project, `azd provision` creates it).

## Quick start (tutor only — no Search needed)

**New Foundry project:**

```powershell
./scripts/deploy.ps1 -EnvironmentName homework-tutor -Location northcentralus
```
```bash
bash ./scripts/deploy.sh homework-tutor northcentralus gpt-5.4-mini
```

**Existing Foundry project** (skips provisioning):

```powershell
./scripts/deploy.ps1 -ProjectEndpoint "https://<account>.services.ai.azure.com/api/projects/<project>"
```
```bash
bash ./scripts/deploy.sh homework-tutor northcentralus gpt-5.4-mini \
  "https://<account>.services.ai.azure.com/api/projects/<project>"
```

## Enabling course knowledge

Grounding via the Azure AI Search toolbox is opt-in:

1. Uncomment the `course-knowledge` service (and the `- course-knowledge` line under `homework-agent.uses`) in [../azure.yaml](../azure.yaml).
2. Have an Azure AI Search service with a populated `course-materials` index.
3. Re-run with the toolbox name + Search endpoint/key:

```powershell
./scripts/deploy.ps1 -ProjectEndpoint "<endpoint>" `
  -ToolboxName course-knowledge `
  -SearchEndpoint "https://<search>.search.windows.net/" -SearchAdminKey "<admin-key>"
```

## Parameters

| PowerShell / bash position | Default | Notes |
|-----------|---------|-------|
| `-EnvironmentName` / #1 | `homework-tutor` | Also becomes the resource-group suffix (`rg-<env>`) for new projects. |
| `-Location` / #2 | `northcentralus` | Needs Foundry + model quota. |
| `-ModelDeploymentName` / #3 | `gpt-5.4-mini` | Must match a `deployments[].name` in the root `azure.yaml`. |
| `-ProjectEndpoint` / #4 | _(empty)_ | Deploy into an existing project; resolves ARM ID + RG and skips provision. |
| `-ToolboxName` / #5 | _(empty)_ | Empty = tutor only. Set to `course-knowledge` to attach the Search toolbox. |
| `-SearchEndpoint` / #6 | _(empty)_ | Azure AI Search URL; with the admin key, creates `course-knowledge-connection`. |
| `-SearchAdminKey` / #7 | _(empty)_ | Admin key for the Search service. |

## Tearing down

```bash
azd down --environment homework-tutor --force --purge
```
