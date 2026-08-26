<#
.SYNOPSIS
  Deploys the HANDS-ON LAB infrastructure via the Azure Developer CLI (azd): a
  Foundry account + project, three model deployments, an Azure AI Search service
  (with RBAC + connection for portal knowledge-base grounding), the professor
  portal, and the course-import pipeline (storage, Service Bus, Event Grid, a
  Functions dispatcher, and a Container Apps extraction job with its registry).
  No hosted agent container and no LTI tool.

.DESCRIPTION
  Creates (or selects) a dedicated azd environment, sets the subscription/region,
  and runs `azd up` to provision lab/infra and deploy the professor portal.
  Prints the outputs you need next.

  The extraction job is deployed by `azd up` along with the portal and the
  dispatcher: its image is built remotely in Azure Container Registry, so no
  local Docker is required.

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
  Application ID of an existing tenant-only Entra app registration. Required:
  Easy Auth is the professor portal's only authentication.

.PARAMETER PortalAuthKeyVaultResourceGroup
  Resource group containing the existing RBAC-enabled Key Vault.

.PARAMETER PortalAuthKeyVaultName
  Existing Key Vault containing the Entra application credential.

.PARAMETER PortalAuthClientSecretName
  Key Vault secret name containing the Entra application credential. The secret
  value itself is never passed to this script: App Service reads it from Key
  Vault at runtime, so it stays out of the azd environment and site settings.

.EXAMPLE
  ./lab/deploy.ps1 -EnvironmentName eduhw10 `
    -PortalAuthClientId '<application-id>' `
    -PortalAuthKeyVaultResourceGroup '<key-vault-resource-group>' `
    -PortalAuthKeyVaultName '<globally-unique-vault-name>'

.EXAMPLE
  ./lab/deploy.ps1 -EnvironmentName eduhw10 `
    -PortalAppName '<portal-app-name>' `
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
  [Parameter(Mandatory)]
  [string]$PortalAuthClientId,
  [Parameter(Mandatory)]
  [string]$PortalAuthKeyVaultResourceGroup,
  [Parameter(Mandatory)]
  [string]$PortalAuthKeyVaultName,
  [string]$PortalAuthClientSecretName = 'portal-auth-client-secret'
)

$ErrorActionPreference = 'Stop'

# The template references the vault as an existing resource and App Service reads
# the secret from it at runtime, so both have to exist before provisioning. The
# secret value is prompted for and written straight to Key Vault: it is never
# passed as a parameter, stored in the azd environment, or set on the site, so it
# cannot end up in shell history, a deployment record, or a file on disk.
function Initialize-PortalAuthSecret {
  Write-Host "==> Checking Key Vault '$PortalAuthKeyVaultName'..." -ForegroundColor Cyan

  az group show -n $PortalAuthKeyVaultResourceGroup -o none 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "    creating resource group '$PortalAuthKeyVaultResourceGroup'"
    az group create -n $PortalAuthKeyVaultResourceGroup -l $Location -o none
    if ($LASTEXITCODE -ne 0) { throw "Could not create resource group '$PortalAuthKeyVaultResourceGroup'." }
  }

  az keyvault show -g $PortalAuthKeyVaultResourceGroup -n $PortalAuthKeyVaultName -o none 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "    creating vault '$PortalAuthKeyVaultName'"
    az keyvault create -g $PortalAuthKeyVaultResourceGroup -n $PortalAuthKeyVaultName --location $Location `
      --enable-rbac-authorization true --enable-purge-protection true --retention-days 90 -o none
    if ($LASTEXITCODE -ne 0) { throw "Could not create Key Vault '$PortalAuthKeyVaultName'. The name must be globally unique." }
  }

  # An RBAC vault grants its creator nothing, so writing the secret needs an
  # explicit role. Re-running is harmless: an existing assignment is not an error.
  $vaultId = az keyvault show -g $PortalAuthKeyVaultResourceGroup -n $PortalAuthKeyVaultName --query id -o tsv
  $callerId = az ad signed-in-user show --query id -o tsv
  if ($callerId) {
    az role assignment create --assignee-object-id $callerId --assignee-principal-type User `
      --role 'Key Vault Secrets Officer' --scope $vaultId -o none 2>$null
  }

  # Confirm the data plane is actually usable before asking for a credential.
  # A tenant policy can create the vault with public access disabled, which makes
  # every secret operation fail; so can RBAC that has not propagated yet. Both
  # surface as the same non-zero exit as a missing secret, so probe first and let
  # a genuine "not found" be the only ambiguity left. Retry briefly, because a
  # role assigned seconds ago routinely takes a moment to take effect.
  $probe = $null
  foreach ($attempt in 1..6) {
    $probe = az keyvault secret list --vault-name $PortalAuthKeyVaultName --maxresults 1 -o none 2>&1
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -lt 6) {
      Write-Host '    waiting for vault access to take effect...'
      Start-Sleep -Seconds 10
    }
  }
  if ($LASTEXITCODE -ne 0) {
    $publicAccess = az keyvault show -g $PortalAuthKeyVaultResourceGroup -n $PortalAuthKeyVaultName --query 'properties.publicNetworkAccess' -o tsv 2>$null
    Write-Host ''
    if ($publicAccess -eq 'Disabled') {
      Write-Host "Key Vault '$PortalAuthKeyVaultName' has public network access disabled, so neither this script nor App Service can reach it." -ForegroundColor Red
      Write-Host 'This is usually a tenant policy applied at creation. Make the vault reachable, then re-run:' -ForegroundColor Red
      Write-Host "  - grant an exemption and run: az keyvault update -g $PortalAuthKeyVaultResourceGroup -n $PortalAuthKeyVaultName --public-network-access Enabled"
      Write-Host '  - or add a private endpoint reachable from both this machine and the App Service subnet'
    }
    else {
      Write-Host "Cannot read secrets from '$PortalAuthKeyVaultName'." -ForegroundColor Red
      Write-Host "Confirm the signed-in account holds 'Key Vault Secrets Officer' on the vault, then re-run." -ForegroundColor Red
    }
    Write-Host ''
    throw "Key Vault '$PortalAuthKeyVaultName' is not usable; no secret was requested. Details: $probe"
  }

  # The data plane is known good, so a failure here means the secret is absent.
  az keyvault secret show --vault-name $PortalAuthKeyVaultName --name $PortalAuthClientSecretName -o none 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "    secret '$PortalAuthClientSecretName' already present; leaving it unchanged"
    return
  }

  Write-Host ''
  Write-Host "Enter the Entra client secret for app registration $PortalAuthClientId." -ForegroundColor Yellow
  Write-Host 'It is written directly to Key Vault and is not echoed or saved locally.'
  $secure = Read-Host -AsSecureString -Prompt 'Client secret'
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if (-not $plain) { throw 'No client secret was entered.' }
    az keyvault secret set --vault-name $PortalAuthKeyVaultName --name $PortalAuthClientSecretName --value $plain -o none
    if ($LASTEXITCODE -ne 0) { throw "Could not write the secret to '$PortalAuthKeyVaultName'." }
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    Remove-Variable plain -ErrorAction SilentlyContinue
  }
  Write-Host "    stored '$PortalAuthClientSecretName'" -ForegroundColor Green
}

Initialize-PortalAuthSecret

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
  # The extraction worker is now deployed by azd up along with the portal and the
  # dispatcher, so it no longer needs a manual publishing step here.
  Write-Host "Next steps ->" -ForegroundColor Cyan
  Write-Host "  1. create the search objects the portal and the import pipeline read:"
  Write-Host "     ../scripts/setup-policy-ingestion.ps1 -EnvironmentName $EnvironmentName"
  Write-Host "     ../scripts/setup-knowledge-bases.ps1  -EnvironmentName $EnvironmentName"
  Write-Host "     (in that order: the second builds a knowledge source over the"
  Write-Host "      policy index the first creates, and fails without it)"
  Write-Host "  2. optional, to answer questions before any course is imported:"
  Write-Host "     python ../scripts/setup-knowledge-base.py --environment-name $EnvironmentName"
  Write-Host "     (loads the sample content into its own 'course-materials' index,"
  Write-Host "      and takes over the 'course-knowledge-base' name from step 2)"
}
finally {
  Pop-Location
}
