param(
  [string]$EnvironmentName = "dev",
  [string]$Location = "eastus2",
  [string]$FoundryProjectEndpoint = $env:FOUNDRY_PROJECT_ENDPOINT,
  [string]$ToolboxEndpoint = $env:TOOLBOX_ENDPOINT,
  [string]$ModelDeploymentName = $env:AZURE_AI_MODEL_DEPLOYMENT_NAME
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($FoundryProjectEndpoint)) {
  $FoundryProjectEndpoint = "https://example.services.ai.azure.com/api/projects/demo"
}

if ([string]::IsNullOrWhiteSpace($ToolboxEndpoint)) {
  $ToolboxEndpoint = "https://example.services.ai.azure.com/api/projects/demo/toolboxes/homework-toolbox/mcp?api-version=v1"
}

if ([string]::IsNullOrWhiteSpace($ModelDeploymentName)) {
  $ModelDeploymentName = "gpt-4o"
}

Write-Host "Provisioning Azure resources for $EnvironmentName in $Location..."

try {
  azd env select $EnvironmentName | Out-Null
} catch {
  azd env new $EnvironmentName --no-prompt | Out-Null
}

azd env set AZURE_LOCATION $Location | Out-Null
azd env set FOUNDRY_PROJECT_ENDPOINT $FoundryProjectEndpoint | Out-Null
azd env set TOOLBOX_ENDPOINT $ToolboxEndpoint | Out-Null
azd env set AZURE_AI_MODEL_DEPLOYMENT_NAME $ModelDeploymentName | Out-Null
azd env set PEDAGOGY_POLICY_URI "./Pedagogy/pedagogy-policy.json" | Out-Null

azd provision --environment $EnvironmentName
azd deploy --environment $EnvironmentName
