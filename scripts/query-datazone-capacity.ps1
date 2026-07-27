#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Reports current US Data Zone available capacity for a set of Azure OpenAI models
    using the Cognitive Services "Model Capacities - List" ARM API.

.DESCRIPTION
    The Model Capacities API (GET .../providers/Microsoft.CognitiveServices/modelCapacities)
    requires an EXACT modelName + modelVersion and returns one row per region per SKU
    (subscription-wide). This script:
      1. Lists models in a US discovery location to find the version(s) for each name.
      2. Calls modelCapacities for every (name, version) pair.
      3. Keeps only US Azure regions (eastus, eastus2, centralus, westus3, ...) with a
         Data Zone SKU (skuName contains "DataZone") = US Data Zone capacity.

    Auth uses an ARM bearer token from the Azure CLI, so run `az login` first.
    (Invoke-RestMethod is used instead of `az rest` because az.cmd mangles the multi-'&'
    query string in the modelCapacities URL.)

.PARAMETER SubscriptionId
    Target subscription. Defaults to the current `az account show` subscription.

.PARAMETER ModelNames
    Model names to query. Defaults to the GPT-5.x family.

.EXAMPLE
    ./query-datazone-capacity.ps1

.EXAMPLE
    ./query-datazone-capacity.ps1 -SubscriptionId 00000000-0000-0000-0000-000000000000 -ModelNames gpt-5.5,gpt-5

.NOTES
    Docs: https://learn.microsoft.com/en-us/rest/api/aiservices/accountmanagement/model-capacities/list
#>
[CmdletBinding()]
param(
    [string]$SubscriptionId,

    [string[]]$ModelNames = @('gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5'),

    [string]$ModelFormat = 'OpenAI',

    [string]$ApiVersion = '2024-10-01',

    # Location used only to enumerate available model versions.
    [string]$DiscoveryLocation = 'eastus2',

    # Substring identifying the Data Zone SKU to report (default: DataZoneProvisionedManaged / PTU).
    [string]$SkuFilter = 'DataZoneProvisionedManaged',

    # Regex matching US Azure regions: eastus, eastus2, centralus, westus3, southcentralus, ...
    [string]$UsRegionRegex = '^(east|west|central|north|south|southcentral|northcentral|westcentral)us\d?$',

    # Show every SKU/region (not just US Data Zone) — useful for debugging what's available
    [switch]$ShowAll
)

$ErrorActionPreference = 'Stop'

# --- Auth -----------------------------------------------------------------
$token = az account get-access-token --resource https://management.azure.com --query accessToken -o tsv 2>$null
if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Error "Could not get an ARM token. Run 'az login' first."
    return
}
$headers = @{ Authorization = "Bearer $token" }

function Invoke-Arm {
    param([string]$Url)
    try {
        return Invoke-RestMethod -Uri $Url -Headers $headers -Method Get
    }
    catch {
        Write-Verbose "ARM call failed for $Url : $($_.Exception.Message)"
        return $null
    }
}

# --- Resolve subscription -------------------------------------------------
if ([string]::IsNullOrWhiteSpace($SubscriptionId)) {
    $acct = az account show --only-show-errors 2>$null | ConvertFrom-Json
    if (-not $acct) {
        Write-Error "Not logged in. Run 'az login' (and optionally 'az account set --subscription <id>') first."
        return
    }
    $SubscriptionId = $acct.id
    Write-Host "Using subscription: $($acct.name) ($SubscriptionId)" -ForegroundColor DarkGray
}

# --- Discover available versions per model name (per-location) ------------
Write-Host "Discovering model versions in $DiscoveryLocation..." -ForegroundColor DarkGray
$modelsUrl = "https://management.azure.com/subscriptions/$SubscriptionId/providers/Microsoft.CognitiveServices/locations/$DiscoveryLocation/models?api-version=$ApiVersion"
$allModels = Invoke-Arm -Url $modelsUrl
if (-not $allModels) {
    Write-Error "Failed to list models in $DiscoveryLocation. Try a different -DiscoveryLocation or check access."
    return
}

$versionMap = @{}
foreach ($m in $allModels.value) {
    $mm = $m.model
    if (-not $mm) { continue }
    if ($mm.format -ne $ModelFormat) { continue }
    $name = $mm.name
    if (-not $versionMap.ContainsKey($name)) {
        $versionMap[$name] = [System.Collections.Generic.SortedSet[string]]::new()
    }
    if ($mm.version) { [void]$versionMap[$name].Add([string]$mm.version) }
}

# --- Query capacity for each requested model ------------------------------
$results = New-Object System.Collections.Generic.List[object]

foreach ($name in $ModelNames) {
    if (-not $versionMap.ContainsKey($name) -or $versionMap[$name].Count -eq 0) {
        Write-Warning "No versions found for '$name' (format $ModelFormat) in this subscription's regions. Skipping."
        continue
    }

    foreach ($ver in $versionMap[$name]) {
        $capUrl = "https://management.azure.com/subscriptions/$SubscriptionId/providers/Microsoft.CognitiveServices/modelCapacities" +
                  "?api-version=$ApiVersion&modelFormat=$ModelFormat&modelName=$name&modelVersion=$ver"
        $caps = Invoke-Arm -Url $capUrl
        if (-not $caps) {
            Write-Warning "No capacity data returned for $name v$ver."
            continue
        }

        foreach ($c in $caps.value) {
            $sku = $c.properties.skuName
            $loc = $c.location

            $isUs      = $loc -match $UsRegionRegex
            $isDataZone = $sku -like "*$SkuFilter*"

            if (-not $ShowAll -and (-not $isUs -or -not $isDataZone)) { continue }

            $results.Add([pscustomobject]@{
                Model             = $name
                Version           = $ver
                Location          = $loc
                Sku               = $sku
                AvailableCapacity = [int]$c.properties.availableCapacity
                IsUsDataZone      = ($isUs -and $isDataZone)
            })
        }
    }
}

# --- Output ---------------------------------------------------------------
if ($results.Count -eq 0) {
    Write-Warning "No matching capacity rows found. Try -ShowAll to see every SKU/region returned by the API."
    return
}

Write-Host ""
Write-Host "US Data Zone available capacity" -ForegroundColor Cyan
$results |
    Sort-Object Model, Version, Location, Sku |
    Format-Table Model, Version, Location, Sku, AvailableCapacity -AutoSize

# Per-model summary (max available across US Data Zone regions/SKUs)
Write-Host "Summary (max US Data Zone availableCapacity per model)" -ForegroundColor Cyan
$results |
    Where-Object IsUsDataZone |
    Group-Object Model |
    ForEach-Object {
        [pscustomobject]@{
            Model                = $_.Name
            MaxAvailableCapacity = ($_.Group | Measure-Object AvailableCapacity -Maximum).Maximum
            Regions              = ($_.Group.Location | Sort-Object -Unique) -join ', '
        }
    } |
    Sort-Object Model |
    Format-Table -AutoSize
