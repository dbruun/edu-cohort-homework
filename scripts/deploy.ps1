param(
  [string]$EnvironmentName = "homework-tutor",
  [string]$Location = "northcentralus",
  [string]$ModelDeploymentName = "gpt-5.4-mini",
  # Optional: wire the course-knowledge Azure AI Search toolbox. Provide both to create the
  # CognitiveSearch connection (course-knowledge-connection) the toolbox in azure.yaml references.
  [string]$SearchEndpoint = "",
  [string]$SearchAdminKey = ""
)

$ErrorActionPreference = "Stop"

# Deploy the real EDU Homework Tutor: the repo-root azure.yaml wires the ai-project model,
# the course-knowledge Azure AI Search toolbox, and the src/HomeworkAgent hosted agent.
$AgentProject = Join-Path $PSScriptRoot ".."
$AgentProject = (Resolve-Path $AgentProject).Path

Write-Host "==> Installing required azd Foundry extensions..."
azd extension install azure.ai.projects   | Out-Null
azd extension install azure.ai.inspector  | Out-Null
azd extension install azure.ai.agents     | Out-Null
azd extension install azure.ai.toolboxes  | Out-Null

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
  # Pedagogy policy path (baked into the container image under ./Pedagogy).
  azd env set PEDAGOGY_POLICY_URI "./Pedagogy/pedagogy-policy.json" | Out-Null

  Write-Host "==> Provisioning Foundry project + model..."
  azd provision --no-prompt

  if ($SearchEndpoint -and $SearchAdminKey) {
    Write-Host "==> Creating course-knowledge-connection (Azure AI Search) for the toolbox..."
    azd ai connection create course-knowledge-connection `
      --kind cognitive-search `
      --target $SearchEndpoint `
      --auth-type api-key `
      --key $SearchAdminKey
    if ($LASTEXITCODE -ne 0) { throw "Failed to create course-knowledge-connection." }
  }
  else {
    Write-Warning "SearchEndpoint/SearchAdminKey not provided. Skipping course-knowledge-connection."
    Write-Warning "The course-knowledge toolbox references it, so 'azd deploy' will fail until it exists."
    Write-Warning "Create it once with:"
    Write-Warning "  azd ai connection create course-knowledge-connection --kind cognitive-search --target `"https://<search>.search.windows.net/`" --auth-type api-key --key `"<admin-key>`""
  }

  Write-Host "==> Deploying toolbox + hosted agent..."
  azd deploy --no-prompt

  Write-Host "==> Smoke testing the deployed agent..."
  azd ai agent invoke "Can you help me get started on a homework problem?"

  Write-Host "==> Done. View the agent with: azd ai agent show --output json"
}
finally {
  Pop-Location
}
