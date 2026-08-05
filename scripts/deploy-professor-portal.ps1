<#
.SYNOPSIS
  Builds and deploys the professor portal to the lab's Linux App Service.

.DESCRIPTION
  Packages the React build with the Node API host, deploys it to App Service,
  and configures tenant-restricted Microsoft Entra Easy Auth. The generated
  client secret is stored only in the App Service settings and is never printed.

.EXAMPLE
  ./scripts/deploy-professor-portal.ps1 -EnvironmentName eduhw07
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$EnvironmentName
)

$ErrorActionPreference = 'Stop'
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
  Invoke-Az webapp deploy -g $resourceGroup -n $appName --src-path $archive --type zip --clean true --restart true

  Write-Host '==> Configuring tenant-restricted Microsoft sign-in...' -ForegroundColor Cyan
  $tenantId = az account show --query tenantId -o tsv
  if ($LASTEXITCODE -ne 0 -or -not $tenantId) { throw "Could not resolve the signed-in tenant. Run 'az login'." }
  $authDisplayName = "$appName-auth"
  $clientId = az ad app list --display-name $authDisplayName --query '[0].appId' -o tsv
  if ($LASTEXITCODE -ne 0) { throw 'Could not query Microsoft Entra app registrations.' }
  $callback = "https://$hostName/.auth/login/aad/callback"
  if (-not $clientId) {
    $clientId = az ad app create --display-name $authDisplayName --sign-in-audience AzureADMyOrg `
      --web-redirect-uris $callback --enable-id-token-issuance true --query appId -o tsv
    if ($LASTEXITCODE -ne 0 -or -not $clientId) {
      throw 'Could not create the portal app registration. Entra application administrator permission may be required.'
    }
    az ad sp create --id $clientId --only-show-errors | Out-Null
  }
  else {
    Invoke-Az ad app update --id $clientId --web-redirect-uris $callback --enable-id-token-issuance true
  }

  $secretSetting = az webapp config appsettings list -g $resourceGroup -n $appName `
    --query "[?name=='MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'].value | [0]" -o tsv
  if (-not $secretSetting) {
    $clientSecret = az ad app credential reset --id $clientId --append --display-name app-service-auth `
      --years 1 --query password -o tsv
    if ($LASTEXITCODE -ne 0 -or -not $clientSecret) { throw 'Could not create the portal authentication credential.' }
    az webapp config appsettings set -g $resourceGroup -n $appName `
      --settings "MICROSOFT_PROVIDER_AUTHENTICATION_SECRET=$clientSecret" --only-show-errors | Out-Null
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
  $subscriptionId = az account show --query id -o tsv
  Invoke-Az rest --method put `
    --uri "/subscriptions/$subscriptionId/resourceGroups/$resourceGroup/providers/Microsoft.Web/sites/$appName/config/authsettingsV2?api-version=2024-04-01" `
    --body $authSettings

  Write-Host "Professor portal deployed: https://$hostName" -ForegroundColor Green
  Write-Host 'All users must sign in through the current Microsoft Entra tenant.'
}
finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
}