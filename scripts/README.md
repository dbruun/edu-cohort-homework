# Deployment scripts

These scripts deploy the **EDU Homework Tutor** as a hosted agent on Microsoft Foundry
using the Azure Developer CLI (`azd`). They are turnkey: a new user who has never
touched this project can run one command and get a working, deployed agent.

## What they do

1. Install the required `azd` Foundry extensions (`azure.ai.agents` and dependencies).
2. Create/select an `azd` environment (this also names the resource group `rg-<env>`).
3. Set the subscription, region, and model deployment name.
4. Provision the Foundry project + model (`azd provision`).
5. Deploy the hosted agent (`azd deploy`).
6. Run a smoke-test invocation.

## Prerequisites

- [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) **1.28+**
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- .NET 10 SDK
- Log in first: `azd auth login` and `az login`.

## PowerShell

```powershell
./scripts/deploy.ps1 -EnvironmentName homework-tutor -Location northcentralus
```

## Bash

```bash
bash ./scripts/deploy.sh homework-tutor northcentralus
```

## Parameters

| Parameter | Default | Notes |
|-----------|---------|-------|
| Environment name | `homework-tutor` | Also becomes the resource-group suffix (`rg-<env>`). |
| Location | `northcentralus` | Needs Foundry + model quota. |
| Model deployment name | `gpt-5.4-mini` | Must match a `deployments[].name` in the agent `azure.yaml`. |

## Tearing down

```bash
azd down --environment homework-tutor --force --purge
```
