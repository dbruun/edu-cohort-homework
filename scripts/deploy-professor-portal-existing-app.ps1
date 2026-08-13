<#
.SYNOPSIS
  Deploys the professor portal using an existing Microsoft Entra app registration.

.DESCRIPTION
  Packages the React build with the Node API host, deploys it to App Service,
  and configures tenant-restricted Microsoft Entra Easy Auth using the existing
  is.dwe.ms.ai.cohorts.easyauth app registration. This script never creates an
  app registration. It preserves existing redirect URIs when adding the portal
  callback and stores any generated client secret only in App Service settings.

.EXAMPLE
  ./scripts/deploy-professor-portal-existing-app.ps1 -EnvironmentName eduhw07
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$EnvironmentName
)

$ErrorActionPreference = 'Stop'
$authDisplayName = 'is.dwe.ms.ai.cohorts.easyauth'
$resourceToken = $EnvironmentName -replace '-', ''
$resourceGroup = "rg-$resourceToken"
$appName = "app-professor-$resourceToken"
$repoRoot = Split-Path $PSScriptRoot -Parent
$uiRoot = Join-Path $repoRoot 'ui'
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "professor-portal-$([guid]::NewGuid())"
$archive = "$stage.zip"

function Invoke-Az {
  param([Parameter(ValueFromRemainingArguments)] [string[]]$Arguments)
  & az @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Azure CLI command failed: az $($Arguments -join ' ')" }
}

try {
  Write-Host "==> Verifying App Service '$appName'..." -ForegroundColor Cyan
  $hostName = az webapp show -g $resourceGroup -n $appName --query defaultHostName -o tsv
  if ($LASTEXITCODE -ne 0 -or -not $hostName) {
    throw "App Service '$appName' was not found in '$resourceGroup'. Re-run ./lab/deploy.ps1 first."
  }

  Write-Host "==> Verifying existing Entra app registration '$authDisplayName'..." -ForegroundColor Cyan
  $appRegistrationsJson = az ad app list --display-name $authDisplayName -o json
  if ($LASTEXITCODE -ne 0) { throw 'Could not query Microsoft Entra app registrations.' }
  $appRegistrations = @($appRegistrationsJson | ConvertFrom-Json)
  if ($appRegistrations.Count -eq 0) {
    throw "Entra app registration '$authDisplayName' was not found in the signed-in tenant. This script will not create it."
  }
  if ($appRegistrations.Count -gt 1) {
    throw "Multiple Entra app registrations named '$authDisplayName' were found. Remove the duplicate registrations before deploying."
  }
  $appRegistration = $appRegistrations[0]
  $clientId = $appRegistration.appId
  if (-not $clientId) { throw "Entra app registration '$authDisplayName' has no application ID." }

  Write-Host '==> Building the React portal...' -ForegroundColor Cyan
  Push-Location (Join-Path $uiRoot 'app')
  try {
    npm install --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Portal dependency installation failed.' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Portal build failed.' }
  }
  finally {
    Pop-Location
  }

  Write-Host '==> Creating the App Service deployment package...' -ForegroundColor Cyan
  New-Item -ItemType Directory -Path $stage | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stage 'api') | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stage 'app') | Out-Null
  Copy-Item (Join-Path $uiRoot 'package.json') $stage
  Copy-Item (Join-Path $uiRoot 'server.js') $stage
  Copy-Item (Join-Path $uiRoot 'api\auth.js') (Join-Path $stage 'api')
  Copy-Item (Join-Path $uiRoot 'api\documents.js') (Join-Path $stage 'api')
  Copy-Item (Join-Path $uiRoot 'api\imscc.js') (Join-Path $stage 'api')
  Copy-Item (Join-Path $uiRoot 'api\policy.js') (Join-Path $stage 'api')
  Copy-Item (Join-Path $uiRoot 'app\dist') (Join-Path $stage 'app') -Recurse
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -Force

  Write-Host '==> Deploying the portal package...' -ForegroundColor Cyan
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    & az webapp deploy -g $resourceGroup -n $appName --src-path $archive --type zip --clean true --restart true
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -eq 2) { throw 'App Service package deployment failed after two attempts.' }
    Write-Warning 'Kudu rejected the package deployment; retrying once.'
  }

  Write-Host "==> Configuring Easy Auth with '$authDisplayName'..." -ForegroundColor Cyan
  $tenantId = az account show --query tenantId -o tsv
  if ($LASTEXITCODE -ne 0 -or -not $tenantId) { throw "Could not resolve the signed-in tenant. Run 'az login'." }
  $callback = "https://$hostName/.auth/login/aad/callback"
  $redirectUris = @($appRegistration.web.redirectUris) + $callback | Where-Object { $_ } | Sort-Object -Unique
  Invoke-Az ad app update --id $clientId --web-redirect-uris @redirectUris --enable-id-token-issuance true

  $servicePrincipalId = az ad sp list --filter "appId eq '$clientId'" --query '[0].id' -o tsv
  if ($LASTEXITCODE -ne 0) { throw "Could not query the Enterprise Application for '$authDisplayName'." }
  if (-not $servicePrincipalId) {
    Invoke-Az ad sp create --id $clientId --only-show-errors
  }

  $subscriptionId = az account show --query id -o tsv
  if ($LASTEXITCODE -ne 0 -or -not $subscriptionId) { throw 'Could not resolve the signed-in subscription.' }
  $currentClientId = az rest --method get `
    --uri "/subscriptions/$subscriptionId/resourceGroups/$resourceGroup/providers/Microsoft.Web/sites/$appName/config/authsettingsV2?api-version=2024-04-01" `
    --query 'properties.identityProviders.azureActiveDirectory.registration.clientId' -o tsv 2>$null
  if ($LASTEXITCODE -ne 0) { $currentClientId = $null }
  $secretSetting = az webapp config appsettings list -g $resourceGroup -n $appName `
    --query "[?name=='MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'].value | [0]" -o tsv
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the App Service authentication secret setting.' }

  if (-not $secretSetting -or $currentClientId -ne $clientId) {
    $clientSecret = az ad app credential reset --id $clientId --append --display-name app-service-auth `
      --years 1 --query password -o tsv
    if ($LASTEXITCODE -ne 0 -or -not $clientSecret) {
      throw "Could not create a credential on '$authDisplayName'. Application administrator permission may be required."
    }
    az webapp config appsettings set -g $resourceGroup -n $appName `
      --settings "MICROSOFT_PROVIDER_AUTHENTICATION_SECRET=$clientSecret" --only-show-errors | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not store the authentication credential in App Service settings.' }
    Remove-Variable clientSecret
  }

  $authSettings = @{
    properties = @{
      platform = @{ enabled = $true; runtimeVersion = '~1' }
      globalValidation = @{
        requireAuthentication = $true
        unauthenticatedClientAction = 'RedirectToLoginPage'
        redirectToProvider = 'azureactivedirectory'
      }
      identityProviders = @{
        azureActiveDirectory = @{
          enabled = $true
          registration = @{
            openIdIssuer = "https://login.microsoftonline.com/$tenantId/v2.0"
            clientId = $clientId
            clientSecretSettingName = 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
          }
          validation = @{ allowedAudiences = @($clientId) }
        }
      }
      login = @{ tokenStore = @{ enabled = $true } }
      httpSettings = @{ requireHttps = $true; routes = @{ apiPrefix = '/.auth' } }
    }
  } | ConvertTo-Json -Depth 12 -Compress
  $authSettingsPath = Join-Path $stage 'authsettings.json'
  [System.IO.File]::WriteAllText($authSettingsPath, $authSettings)
  Invoke-Az rest --method put `
    --uri "/subscriptions/$subscriptionId/resourceGroups/$resourceGroup/providers/Microsoft.Web/sites/$appName/config/authsettingsV2?api-version=2024-04-01" `
    --headers 'Content-Type=application/json' `
    --body "@$authSettingsPath"

  Write-Host "Professor portal deployed: https://$hostName" -ForegroundColor Green
  Write-Host "Easy Auth uses existing app registration '$authDisplayName' ($clientId)."
}
finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
}