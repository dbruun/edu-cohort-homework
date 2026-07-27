# Deployment scripts

These scripts deploy the **EDU Homework Tutor** as a hosted agent on Microsoft Foundry
using the Azure Developer CLI (`azd`). They are turnkey: a new user who has never
touched this project can run one command and get a working, deployed agent.

## What they do

1. Install the required `azd` Foundry extensions (`azure.ai.agents`, `azure.ai.toolboxes`, and dependencies).
2. Create/select an `azd` environment (this also names the resource group `rg-<env>`).
3. Set the subscription, region, model deployment name, and pedagogy policy path.
4. Provision the Foundry project + model (`azd provision`).
5. If Search credentials are supplied, create the `course-knowledge-connection` (Azure AI Search) the toolbox references.
6. Deploy the `course-knowledge` toolbox + hosted agent (`azd deploy`).
7. Run a smoke-test invocation.

> The scripts deploy the repo-root [`azure.yaml`](../azure.yaml), which wires the `ai-project`
> model, the `course-knowledge` Azure AI Search toolbox, and the `src/HomeworkAgent` hosted agent
> (pedagogy composed from `Pedagogy/pedagogy-policy.json`).

## Prerequisites

- [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) **1.28+**
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- .NET 10 SDK
- Log in first: `azd auth login` and `az login`.
- For the knowledge toolbox: an Azure AI Search service with a populated `course-materials` index. Pass its endpoint + admin key (see parameters) so the deploy creates `course-knowledge-connection`. Without them, the toolbox deploy step fails until the connection is created manually.

## PowerShell

```powershell
./scripts/deploy.ps1 -EnvironmentName homework-tutor -Location northcentralus `
  -SearchEndpoint "https://<search>.search.windows.net/" -SearchAdminKey "<admin-key>"
```

## Bash

```bash
bash ./scripts/deploy.sh homework-tutor northcentralus gpt-5.4-mini \
  "https://<search>.search.windows.net/" "<admin-key>"
```

## Parameters

| Parameter | Default | Notes |
|-----------|---------|-------|
| Environment name | `homework-tutor` | Also becomes the resource-group suffix (`rg-<env>`). |
| Location | `northcentralus` | Needs Foundry + model quota. |
| Model deployment name | `gpt-5.4-mini` | Must match a `deployments[].name` in the root `azure.yaml`. |
| Search endpoint | _(empty)_ | Azure AI Search URL; with the admin key, creates `course-knowledge-connection`. |
| Search admin key | _(empty)_ | Admin key for the Search service. Omit both to skip the connection (deploy will warn). |

## Tearing down

```bash
azd down --environment homework-tutor --force --purge
```
