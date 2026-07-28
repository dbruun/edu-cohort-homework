param(
  [string]$EnvironmentName = "homework-tutor",
  [string]$Location = "northcentralus",
  [string]$ModelDeploymentName = "gpt-5.4-mini",
  # Deploy into an EXISTING Foundry project instead of provisioning a new one. Pass the project
  # endpoint (e.g. https://<account>.services.ai.azure.com/api/projects/<project>). When set, the
  # script resolves the project ARM ID + resource group and skips `azd provision`.
  [string]$ProjectEndpoint = "",
  # Course-knowledge Azure AI Search toolbox. Empty (default) = tutor-only deploy, no knowledge
  # grounding, no Search prerequisites. To enable: uncomment the `course-knowledge` service in
  # azure.yaml, set -ToolboxName course-knowledge, and provide the Search endpoint + key below.
  [string]$ToolboxName = "",
  [string]$SearchEndpoint = "",
  [string]$SearchAdminKey = ""
)

$ErrorActionPreference = "Stop"

# Deploy the EDU Homework Tutor from the repo-root azure.yaml (ai-project model + src/HomeworkAgent
# hosted agent, with the pedagogy policy composed into the agent's instructions).
$AgentProject = Join-Path $PSScriptRoot ".."
$AgentProject = (Resolve-Path $AgentProject).Path

Write-Host "==> Checking Azure CLI login..."
$Account = az account show 2>$null | ConvertFrom-Json
if (-not $Account) { throw "Not logged in. Run 'az login' (and 'azd auth login'), then re-run." }
$SubscriptionId = $Account.id
$TenantId = $Account.tenantId
Write-Host "    Subscription: $($Account.name) ($SubscriptionId)"

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

  Write-Host "==> Setting core azd environment values..."
  azd env set AZURE_SUBSCRIPTION_ID $SubscriptionId | Out-Null
  azd env set AZURE_TENANT_ID $TenantId | Out-Null
  azd env set AZURE_LOCATION $Location | Out-Null
  # Must be set before deploy so the agent starts with a valid model deployment.
  azd env set AZURE_AI_MODEL_DEPLOYMENT_NAME $ModelDeploymentName | Out-Null
  # Pedagogy policy path (baked into the image under ./Pedagogy).
  azd env set PEDAGOGY_POLICY_URI "./Pedagogy/pedagogy-policy.json" | Out-Null
  # Empty = tutor only; a name attaches that Foundry Toolbox for course-knowledge grounding.
  azd env set TOOLBOX_NAME $ToolboxName | Out-Null

  if ($ProjectEndpoint) {
    Write-Host "==> Using existing Foundry project (skipping provision)..."
    $AccountName = ([Uri]$ProjectEndpoint).Host.Split('.')[0]
    $ProjectName = (($ProjectEndpoint -split '/projects/')[-1] -split '\?')[0].TrimEnd('/')
    $AccountId = az resource list --resource-type "Microsoft.CognitiveServices/accounts" `
      --query "[?name=='$AccountName'].id | [0]" -o tsv
    if (-not $AccountId) { throw "Foundry account '$AccountName' not found in subscription $SubscriptionId." }
    $ResourceGroup = az resource list --resource-type "Microsoft.CognitiveServices/accounts" `
      --query "[?name=='$AccountName'].resourceGroup | [0]" -o tsv

    azd env set AZURE_AI_PROJECT_ENDPOINT $ProjectEndpoint | Out-Null
    azd env set FOUNDRY_PROJECT_ENDPOINT $ProjectEndpoint | Out-Null
    azd env set AZURE_AI_PROJECT_ID "$AccountId/projects/$ProjectName" | Out-Null
    azd env set AZURE_RESOURCE_GROUP $ResourceGroup | Out-Null
    Write-Host "    Project '$ProjectName' in resource group '$ResourceGroup'."
  }
  else {
    Write-Host "==> Provisioning Foundry project + model..."
    azd provision --no-prompt
  }

  if ($ToolboxName -and $SearchEndpoint -and $SearchAdminKey) {
    Write-Host "==> Creating $ToolboxName search connection (course-knowledge-connection)..."
    azd ai connection create course-knowledge-connection `
      --kind cognitive-search `
      --target $SearchEndpoint `
      --auth-type api-key `
      --key $SearchAdminKey
    if ($LASTEXITCODE -ne 0) { throw "Failed to create course-knowledge-connection." }
  }
  elseif ($ToolboxName) {
    Write-Warning "ToolboxName '$ToolboxName' set but SearchEndpoint/SearchAdminKey missing."
    Write-Warning "Ensure the toolbox service is uncommented in azure.yaml and its connection + index exist, or deploy will fail."
  }

  Write-Host "==> Deploying hosted agent..."
  azd deploy homework-agent --no-prompt

  Write-Host "==> Smoke testing the deployed agent..."
  azd ai agent invoke homework-agent "Can you help me get started on a homework problem?"

  Write-Host "==> Done. View the agent with: azd ai agent show homework-agent --output json"
}
finally {
  Pop-Location
}
