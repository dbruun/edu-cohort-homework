# Deployment scripts

Use these scripts to provision and deploy the accelerator to Azure with Azure Developer CLI.

## PowerShell

```powershell
./scripts/deploy.ps1 -EnvironmentName dev -Location eastus2
```

You can also pass explicit Foundry settings if you want to override the defaults:

```powershell
./scripts/deploy.ps1 -EnvironmentName dev -Location eastus2 -FoundryProjectEndpoint https://example.services.ai.azure.com/api/projects/demo -ToolboxEndpoint https://example.services.ai.azure.com/api/projects/demo/toolboxes/homework-toolbox/mcp?api-version=v1 -ModelDeploymentName gpt-4o
```

## Bash

```bash
bash ./scripts/deploy.sh dev eastus2
```

The scripts now also configure the runtime values consumed by the agent for:
- Foundry project endpoint
- toolbox endpoint
- model deployment name
- pedagogy policy path

Prerequisites:
- Azure Developer CLI installed and authenticated
- An Azure subscription selected
