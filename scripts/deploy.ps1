param(
  [string]$EnvironmentName = "homework-tutor",
  [string]$Location = "northcentralus",
  [string]$ModelDeploymentName = "gpt-5.4-mini"
)

$ErrorActionPreference = "Stop"

# Path to the hosted Foundry agent project (contains azure.yaml with host: azure.ai.agent).
$AgentProject = Join-Path $PSScriptRoot ".." "foundry-tutor" "hello-world-dotnet-agent-framework"
$AgentProject = (Resolve-Path $AgentProject).Path

Write-Host "==> Installing required azd Foundry extensions..."
azd extension install azure.ai.projects  | Out-Null
azd extension install azure.ai.inspector | Out-Null
azd extension install azure.ai.agents    | Out-Null

Push-Location $AgentProject
try {
  Write-Host "==> Selecting/creating azd environment '$EnvironmentName' (resource group will be rg-$EnvironmentName)..."
  azd env select $EnvironmentName 2>$null
  if ($LASTEXITCODE -ne 0) {
    azd env new $EnvironmentName --no-prompt
    if ($LASTEXITCODE -ne 0) { throw "Failed to create azd environment '$EnvironmentName'." }
  }

  $SubscriptionId = az account show --query id -o tsv
  Write-Host "==> Using subscription $SubscriptionId in $Location"
  azd env set AZURE_SUBSCRIPTION_ID $SubscriptionId | Out-Null
  azd env set AZURE_LOCATION $Location | Out-Null
  # Must be set before deploy so the agent container starts with a valid model deployment.
  azd env set AZURE_AI_MODEL_DEPLOYMENT_NAME $ModelDeploymentName | Out-Null

  Write-Host "==> Provisioning Foundry project + model..."
  azd provision --no-prompt

  Write-Host "==> Deploying hosted agent..."
  azd deploy --no-prompt

  Write-Host "==> Smoke testing the deployed agent..."
  azd ai agent invoke "Can you help me get started on a homework problem?"

  Write-Host "==> Done. View the agent with: azd ai agent show --output json"
}
finally {
  Pop-Location
}
