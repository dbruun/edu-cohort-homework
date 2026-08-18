<#
.SYNOPSIS
  Builds the blob -> Azure AI Search ingestion pipeline for pedagogy policies:
  a flat index, a blob data source (managed-identity auth), and an indexer that
  parses each professor's policy JSON into filterable fields plus one
  searchable text rendition.

.DESCRIPTION
  The professor portal writes one blob per professor to the `policies`
  container, named `<professorId>.json`. This script projects those blobs into
  `pedagogy-policy-index`, which backs the pedagogy-policy knowledge base the
  tutor agent must consult before answering course questions.

  Deliberately simpler than the course-content pipeline:
    - No chunking. A policy document is far smaller than one chunk.
    - No vectorization. Retrieval is a handful of documents keyed by professor;
      keyword + semantic ranking is sufficient and removes a failure surface.

  The blob JSON's nested `subjectOverrides` and `courseGroups` are NOT indexed
  as structured fields — blob JSON parsing drops complex types. They are instead
  flattened by the portal into `policyText`, which is what the agent grounds on.

  Prerequisites (created outside this script):
    - `policies` container on the storage account (created by Bicep).
    - The Search service managed identity has Storage Blob Data Reader on the
      storage account.

  Idempotent (PUT / createOrUpdate); safe to re-run.

.PARAMETER EnvironmentName
  azd environment name. Used to derive the resource group (rg-<token>) and to
  auto-discover the search service and storage account.

.EXAMPLE
  ./scripts/setup-policy-ingestion.ps1 -EnvironmentName cohort-demo
#>
[CmdletBinding()]
param(
  [string]$EnvironmentName,
  [string]$ResourceGroup,
  [string]$SearchService,
  [string]$StorageAccount,
  [string]$ContainerName = 'policies',
  [string]$IndexName = 'pedagogy-policy-index',
  [string]$DataSourceName = 'pedagogy-policy-ds',
  [string]$IndexerName = 'pedagogy-policy-idxr',
  [string]$ApiVersion = '2026-04-01'
)

$ErrorActionPreference = 'Stop'

function Resolve-Rg {
  param($rg, $env)
  if ($rg) { return $rg }
  if ($env) { return "rg-$($env -replace '-', '')" }
  throw 'Provide -ResourceGroup or -EnvironmentName.'
}

$ResourceGroup = Resolve-Rg $ResourceGroup $EnvironmentName
Write-Host "==> Resource group: $ResourceGroup"

if (-not $SearchService) {
  $SearchService = az search service list -g $ResourceGroup --query "[0].name" -o tsv
  if (-not $SearchService) { throw "No Azure AI Search service found in $ResourceGroup." }
}
if (-not $StorageAccount) {
  $StorageAccount = az storage account list -g $ResourceGroup --query "[?kind=='StorageV2'] | [0].name" -o tsv
  if (-not $StorageAccount) { throw "No storage account found in $ResourceGroup." }
}
$subscriptionId = az account show --query id -o tsv
$storageId = "/subscriptions/$subscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Storage/storageAccounts/$StorageAccount"
$searchEndpoint = "https://$SearchService.search.windows.net"
Write-Host "==> Search: $SearchService | Storage: $StorageAccount"

$token = az account get-access-token --resource https://search.azure.com --query accessToken -o tsv
if (-not $token) { throw "Could not acquire an Azure AI Search token. Run 'az login'." }
$headers = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }

function Invoke-Search {
  param([string]$Method, [string]$Path, [object]$Body)
  $uri = "${searchEndpoint}${Path}?api-version=${ApiVersion}"
  $json = if ($null -ne $Body) { $Body | ConvertTo-Json -Depth 30 } else { $null }
  return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -Body $json
}

# --- 1. Index -------------------------------------------------------------
Write-Host "==> Creating/updating index '$IndexName'..."
$index = @{
  name   = $IndexName
  fields = @(
    @{ name = 'id'; type = 'Edm.String'; key = $true; filterable = $true; analyzer = 'keyword' }
    @{ name = 'professorId'; type = 'Edm.String'; searchable = $true; filterable = $true; retrievable = $true }
    @{ name = 'professorName'; type = 'Edm.String'; searchable = $true; filterable = $true; retrievable = $true }
    @{ name = 'policyText'; type = 'Edm.String'; searchable = $true; retrievable = $true; analyzer = 'en.microsoft' }
    @{ name = 'helpLevel'; type = 'Edm.String'; searchable = $true; filterable = $true; facetable = $true; retrievable = $true }
    @{ name = 'maxStepsRevealed'; type = 'Edm.Int32'; filterable = $true; retrievable = $true }
    @{ name = 'allowDirectAnswers'; type = 'Edm.Boolean'; filterable = $true; retrievable = $true }
    @{ name = 'citationsRequired'; type = 'Edm.Boolean'; filterable = $true; retrievable = $true }
  )
  semantic = @{
    defaultConfiguration = 'default'
    configurations = @(@{
        name = 'default'
        prioritizedFields = @{
          titleField = @{ fieldName = 'professorName' }
          prioritizedContentFields = @(@{ fieldName = 'policyText' })
          prioritizedKeywordsFields = @(@{ fieldName = 'helpLevel' })
        }
      })
  }
}
Invoke-Search -Method 'Put' -Path "/indexes('$IndexName')" -Body $index | Out-Null
Write-Host '    index ready.'

# --- 2. Data source (blob, managed-identity auth) -------------------------
Write-Host "==> Creating/updating data source '$DataSourceName'..."
$dataSource = @{
  name        = $DataSourceName
  type        = 'azureblob'
  credentials = @{ connectionString = "ResourceId=$storageId;" }
  container   = @{ name = $ContainerName }
}
Invoke-Search -Method 'Put' -Path "/datasources('$DataSourceName')" -Body $dataSource | Out-Null
Write-Host '    data source ready.'

# --- 3. Indexer -----------------------------------------------------------
Write-Host "==> Creating/updating indexer '$IndexerName'..."
$indexer = @{
  name            = $IndexerName
  dataSourceName  = $DataSourceName
  targetIndexName = $IndexName
  parameters      = @{ configuration = @{ parsingMode = 'json'; dataToExtract = 'contentAndMetadata' } }
  # The blob path is the only stable unique value; base64 keeps it key-legal.
  fieldMappings   = @(
    @{ sourceFieldName = 'metadata_storage_path'; targetFieldName = 'id'; mappingFunction = @{ name = 'base64Encode' } }
  )
}
Invoke-Search -Method 'Put' -Path "/indexers('$IndexerName')" -Body $indexer | Out-Null
Write-Host '    indexer ready.'

# --- 4. Run + report ------------------------------------------------------
Write-Host '==> Running the indexer...'
Invoke-Search -Method 'Post' -Path "/indexers('$IndexerName')/run" | Out-Null
Start-Sleep -Seconds 8
$status = Invoke-Search -Method 'Get' -Path "/indexers('$IndexerName')/status"
$last = $status.lastResult
Write-Host ''
Write-Host "Pedagogy policy ingestion configured on $searchEndpoint" -ForegroundColor Green
Write-Host "  container : $ContainerName"
Write-Host "  index     : $IndexName"
Write-Host "  indexer   : $IndexerName"
Write-Host ''
Write-Host "  last run  : status=$($last.status) processed=$($last.itemsProcessed) failed=$($last.itemsFailed)"
if ($last.errorMessage) { Write-Host "  error     : $($last.errorMessage)" -ForegroundColor Red }
foreach ($e in $last.errors) { Write-Host "  item error: $($e.errorMessage)" -ForegroundColor Red }

# itemsProcessed is 0 on a no-change re-run, so report the index instead.
$docCount = (Invoke-Search -Method 'Get' -Path "/indexes('$IndexName')/docs/`$count")
Write-Host "  documents : $docCount in $IndexName"
if ([int]$docCount -eq 0) {
  Write-Host ''
  Write-Host '  Index is empty. Save a policy in the professor portal, then re-run this script.' -ForegroundColor Yellow
}
