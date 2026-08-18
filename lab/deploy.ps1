<#
.SYNOPSIS
  Deploys the HANDS-ON LAB infrastructure via the Azure Developer CLI (azd): a
  Foundry account + project, three model deployments, and an Azure AI Search service
  (with RBAC + connection for portal knowledge-base grounding). Slim lab stack —
  no hosted agent container, LTI tool, or ACR.

.DESCRIPTION
  Creates (or selects) a dedicated azd environment, sets the subscription/region,
  and runs `azd up` to provision lab/infra and deploy the professor portal.
  Prints the outputs you need next.

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

.PARAMETER PortalAuthClientId
  Application ID of an existing tenant-only Entra app registration. When set,
  all PortalAuthKeyVault* parameters are required and Bicep configures Easy Auth.

.PARAMETER PortalAuthKeyVaultResourceGroup
  Resource group containing the existing RBAC-enabled Key Vault.

.PARAMETER PortalAuthKeyVaultName
  Existing Key Vault containing the Entra application credential.

.PARAMETER PortalAuthClientSecretName
  Key Vault secret name containing the Entra application credential.

.PARAMETER PortalAuthClientSecret
  Entra client secret value. Supply this instead of the Key Vault parameters when
  no RBAC-enabled Key Vault is available. Stored only in the local azd environment
  and as an App Service setting.

.EXAMPLE
  ./lab/deploy.ps1 -EnvironmentName eduhw01

.EXAMPLE
  ./lab/deploy.ps1 -EnvironmentName eduhw10 `
    -PortalAuthClientId '<application-id>' `
    -PortalAuthKeyVaultResourceGroup '<key-vault-resource-group>' `
    -PortalAuthKeyVaultName '<key-vault-name>' `
    -PortalAuthClientSecretName '<secret-name>'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$EnvironmentName,
  [string]$Location = 'northcentralus',
  [ValidateSet('basic', 'standard', 'standard2', 'standard3')]
  [string]$SearchSku = 'basic',
  [string]$PortalAppName = '',
  [string]$PortalAuthClientId = '',
  [string]$PortalAuthKeyVaultResourceGroup = '',
  [string]$PortalAuthKeyVaultName = '',
  [string]$PortalAuthClientSecretName = '',
  [string]$PortalAuthClientSecret = ''
)

$ErrorActionPreference = 'Stop'

$keyVaultValues = @($PortalAuthKeyVaultResourceGroup, $PortalAuthKeyVaultName, $PortalAuthClientSecretName)
$configuredKeyVaultValues = @($keyVaultValues | Where-Object { $_ })
if ($PortalAuthClientId) {
  if ($PortalAuthClientSecret -and $configuredKeyVaultValues.Count -ne 0) {
    throw 'Supply either PortalAuthClientSecret or the PortalAuthKeyVault* parameters, not both.'
  }
  if (-not $PortalAuthClientSecret -and $configuredKeyVaultValues.Count -ne $keyVaultValues.Count) {
    throw 'Easy Auth requires PortalAuthClientSecret, or all three PortalAuthKeyVault* parameters.'
  }
}
elseif ($PortalAuthClientSecret -or $configuredKeyVaultValues.Count -ne 0) {
  throw 'PortalAuthClientId is required when any other portal authentication parameter is supplied.'
}

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
  $tenantId = az account show --query tenantId -o tsv
  if (-not $tenantId) { throw "Could not read the current tenant. Run 'az login' and 'az account set'." }
  Write-Host "==> Using subscription $subscriptionId in $Location (search=$SearchSku)"
  azd env set AZURE_SUBSCRIPTION_ID $subscriptionId | Out-Null
  azd env set AZURE_TENANT_ID $tenantId | Out-Null
  azd env set AZURE_LOCATION $Location | Out-Null
  azd env set SEARCH_SKU $SearchSku | Out-Null
  azd env set PORTAL_APP_NAME_OVERRIDE $PortalAppName | Out-Null
  azd env set PORTAL_AUTH_CLIENT_ID $PortalAuthClientId | Out-Null
  azd env set PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP $PortalAuthKeyVaultResourceGroup | Out-Null
  azd env set PORTAL_AUTH_KEY_VAULT_NAME $PortalAuthKeyVaultName | Out-Null
  azd env set PORTAL_AUTH_CLIENT_SECRET_NAME $PortalAuthClientSecretName | Out-Null
  azd env set PORTAL_AUTH_CLIENT_SECRET $PortalAuthClientSecret | Out-Null

  Write-Host "==> Provisioning the lab and deploying the professor portal (a few minutes)..." -ForegroundColor Cyan
  azd up --no-prompt
  if ($LASTEXITCODE -ne 0) { throw "azd up failed. See the output above." }

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
  Write-Host "  python ../scripts/setup-knowledge-base.py --environment-name $EnvironmentName"
}
finally {
  Pop-Location
}
