<#
.SYNOPSIS
  Points the dispatcher at the extraction worker image azd just pushed.

.DESCRIPTION
  Run as a postdeploy hook for the extraction-worker service.

  The dispatcher cannot simply trigger the extraction job: it has to tell the
  worker which import to process, and the Container Apps start API replaces the
  container definition rather than merging into it. Every start call therefore
  restates the whole container, image included, which the dispatcher reads from
  its EXTRACTION_JOB_IMAGE setting.

  Provisioning writes that setting from the Bicep `jobImage`, which is the public
  placeholder until an image exists to point at — and on a new environment none
  can, because the registry is created by that same deployment. `azd deploy`
  builds and pushes the real image and rewrites the *job* template, but nothing
  updates the dispatcher's copy. Left alone the dispatcher keeps launching the
  placeholder, which exits successfully without touching the import, so uploads
  sit in processing rather than failing.

  This closes that gap from both ends: it updates the live app setting, and it
  records the image in EXTRACTION_IMAGE so a later `azd provision` reproduces it
  instead of reverting to the placeholder.
#>
[CmdletBinding()]
param(
  [string]$Image = $env:SERVICE_EXTRACTION_WORKER_IMAGE_NAME,
  [string]$FunctionApp = $env:DISPATCHER_FUNCTION_NAME,
  [string]$ResourceGroup = $env:AZURE_RESOURCE_GROUP,
  [string]$JobName = $env:EXTRACTION_JOB_NAME
)

$ErrorActionPreference = 'Stop'

# The azd project is this script's own directory's parent: hooks run with the
# project directory as their working directory, but `azd env set` is resolved
# from the current location, so it is pinned explicitly rather than assumed.
$azdProject = Split-Path -Parent $PSScriptRoot

if (-not $ResourceGroup) { throw 'AZURE_RESOURCE_GROUP is required.' }
if (-not $FunctionApp) { throw 'DISPATCHER_FUNCTION_NAME is required.' }

# azd publishes the pushed image as a service property. Falling back to the job
# keeps the hook working when it is run on its own, via `azd hooks run`, where
# no deployment has just happened to set that variable.
if (-not $Image) {
  if (-not $JobName) { throw 'Neither SERVICE_EXTRACTION_WORKER_IMAGE_NAME nor EXTRACTION_JOB_NAME is set.' }
  $Image = az containerapp job show --name $JobName --resource-group $ResourceGroup `
    --query 'properties.template.containers[0].image' --output tsv 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $Image) { throw "Could not read the image from job '$JobName'." }
}

if ($Image -like 'mcr.microsoft.com/k8se/quickstart-jobs*') {
  throw @"
Refusing to point the dispatcher at the placeholder image.

The extraction worker has not been deployed yet. Run 'azd deploy extraction-worker'
(or 'azd up'), which builds the image in Azure Container Registry and pushes it.
"@
}

$current = az functionapp config appsettings list --name $FunctionApp --resource-group $ResourceGroup `
  --query "[?name=='EXTRACTION_JOB_IMAGE'].value | [0]" --output tsv 2>$null

if ($current -eq $Image) {
  Write-Host "Dispatcher already starts $Image"
}
else {
  # Changing an app setting restarts the Function App, so it is only written when
  # it actually differs.
  Write-Host "Pointing $FunctionApp at $Image"
  az functionapp config appsettings set --name $FunctionApp --resource-group $ResourceGroup `
    --settings "EXTRACTION_JOB_IMAGE=$Image" --output none
  if ($LASTEXITCODE -ne 0) { throw 'Could not update EXTRACTION_JOB_IMAGE on the dispatcher.' }
}

# Without this, the next `azd provision` rewrites the app setting back to the
# placeholder and the dispatcher silently regresses.
Push-Location $azdProject
try {
  azd env set EXTRACTION_IMAGE $Image
  if ($LASTEXITCODE -ne 0) { throw 'Could not record EXTRACTION_IMAGE in the azd environment.' }
}
finally {
  Pop-Location
}
