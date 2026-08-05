<#
.SYNOPSIS
  Deploys the HANDS-ON LAB infrastructure via the Azure Developer CLI (azd): a
  Foundry account + project, three model deployments, and an Azure AI Search service
  (with RBAC + connection for portal knowledge-base grounding). Slim lab stack —
  no hosted agent container, LTI tool, or ACR.

.DESCRIPTION
  Creates (or selects) a dedicated azd environment, sets the subscription/region,
  and runs `azd provision` against lab/infra (subscription-scoped Bicep that
  creates the resource group `rg-<token>`). Prints the outputs you need next.

  Requires: Azure Developer CLI (azd) + Azure CLI, logged in (`azd auth login`
  and `az login`), and permission to create resource groups AND role assignments
  at the subscription (Owner, or Contributor + User Access Administrator).

.PARAMETER EnvironmentName
  azd environment name. Also drives resource naming: rg-<token>, aif-<token>,
  srch-<token> (token = the name with dashes removed).

.PARAMETER Location
  Azure region. Must have gpt-5.4 and gpt-5.4-mini quota. Default: northcentralus.

.PARAMETER SearchSku
  Azure AI Search SKU. Default 'basic' (fine for the lab).

.EXAMPLE
  ./lab/deploy.ps1 -EnvironmentName eduhw01
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$EnvironmentName,
  [string]$Location = 'northcentralus',
  [ValidateSet('basic', 'standard', 'standard2', 'standard3')]
  [string]$SearchSku = 'basic'
)

$ErrorActionPreference = 'Stop'

Push-Location $PSScriptRoot
try {
  Write-Host "==> Selecting/creating azd environment '$EnvironmentName'..." -ForegroundColor Cyan
  azd env select $EnvironmentName 2>$null
  if ($LASTEXITCODE -ne 0) {
    azd env new $EnvironmentName --no-prompt
    if ($LASTEXITCODE -ne 0) { throw "Failed to create azd environment '$EnvironmentName'." }
  }

  $subscriptionId = az account show --query id -o tsv
  if (-not $subscriptionId) { throw "Could not read the current subscription. Run 'az login' and 'az account set'." }
  Write-Host "==> Using subscription $subscriptionId in $Location (search=$SearchSku)"
  azd env set AZURE_SUBSCRIPTION_ID $subscriptionId | Out-Null
  azd env set AZURE_LOCATION $Location | Out-Null
  azd env set SEARCH_SKU $SearchSku | Out-Null

  Write-Host "==> Provisioning Foundry + models + Azure AI Search (a few minutes)..." -ForegroundColor Cyan
  azd provision --no-prompt
  if ($LASTEXITCODE -ne 0) { throw "azd provision failed. See the output above." }

  function Get-AzdValue([string]$name) { (azd env get-value $name 2>$null) }

  Write-Host ""
  Write-Host "Lab infrastructure deployed (azd env '$EnvironmentName')." -ForegroundColor Green
  Write-Host "  resource group    : $(Get-AzdValue RESOURCE_GROUP_NAME)"
  Write-Host "  Foundry account   : $(Get-AzdValue FOUNDRY_ACCOUNT_NAME)"
  Write-Host "  Foundry project   : $(Get-AzdValue FOUNDRY_PROJECT_NAME)"
  Write-Host "  project endpoint  : $(Get-AzdValue FOUNDRY_PROJECT_ENDPOINT)"
  Write-Host "  search service    : $(Get-AzdValue SEARCH_SERVICE_NAME)"
  Write-Host "  chat model        : $(Get-AzdValue CHAT_DEPLOYMENT_NAME)"
  Write-Host "  KB reasoning model: $(Get-AzdValue KB_REASONING_DEPLOYMENT_NAME)"
  Write-Host "  embeddings model  : $(Get-AzdValue EMBEDDING_DEPLOYMENT_NAME)"
  Write-Host "  professor portal  : $(Get-AzdValue PORTAL_URL)"
  Write-Host "  policy storage    : $(Get-AzdValue POLICY_STORAGE_ACCOUNT)"
  Write-Host ""
  Write-Host "Next: seed the knowledge base ->" -ForegroundColor Cyan
  Write-Host "  ./scripts/setup-knowledge-base.ps1 -EnvironmentName $EnvironmentName"
}
finally {
  Pop-Location
}
