<#
.SYNOPSIS
  Creates the Azure AI Search index, knowledge source, and knowledge base that
  back the EDU homework tutor's course-material grounding, and seeds it with
  dummy microbiology data.

.DESCRIPTION
  The search service itself is provisioned by Bicep (infra/resources.bicep). The
  index / knowledge source / knowledge base are DATA-PLANE objects, so they are
  created here rather than in ARM. This script is idempotent (PUT/mergeOrUpload)
  and safe to re-run.

  It performs, in order:
    1. Resolve the search service, resource group, and Foundry account.
    2. Create the `course-materials` hybrid search index (text + vectors + semantic ranker).
    3. Embed and upload the seed documents (scripts/seed-data/microbiology.json).
    4. Create a `searchIndex` knowledge source over that index.
    5. Create a knowledge base that references the source and uses the
       gpt-5.4-mini deployment for query planning / answer synthesis.

.PARAMETER EnvironmentName
  azd environment name. Used to derive the resource group (rg-<token>) and to
  auto-discover the search service and Foundry account when not supplied.

.EXAMPLE
  ./scripts/setup-knowledge-base.ps1 -EnvironmentName eduhw01

.NOTES
  Requires: Azure CLI (az login), Cognitive Services OpenAI User on Foundry,
  and Search Service Contributor + Search Index Data Contributor on Search.
  The lab Bicep grants these roles to the identity that deploys the environment.
#>
[CmdletBinding()]
param(
  [string]$EnvironmentName,
  [string]$ResourceGroup,
  [string]$SearchService,
  [string]$FoundryAccount,
  [string]$IndexName = 'course-materials',
  [string]$KnowledgeSourceName = 'course-materials-source',
  [string]$KnowledgeBaseName = 'course-knowledge-base',
  [string]$KbModelDeployment = 'gpt-5.4-mini',
  [ValidateSet('gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-5-nano')]
  [string]$KbModelName = 'gpt-5.4-mini',
  [string]$EmbeddingDeployment = 'text-embedding-3-small',
  [ValidateSet('text-embedding-3-small')]
  [string]$EmbeddingModelName = 'text-embedding-3-small',
  [ValidateRange(1, 1536)]
  [int]$EmbeddingDimensions = 1536,
  [string]$OpenAiApiVersion = '2024-10-21',
  [string]$ApiVersion = '2026-04-01',
  [string]$SeedDataPath
)

$ErrorActionPreference = 'Stop'

function Resolve-Rg {
  param($rg, $env)
  if ($rg) { return $rg }
  if ($env) { return "rg-$($env -replace '-', '')" }
  throw "Provide -ResourceGroup or -EnvironmentName so the resource group can be resolved."
}

$ResourceGroup = Resolve-Rg $ResourceGroup $EnvironmentName
Write-Host "==> Resource group: $ResourceGroup"

if (-not $SearchService) {
  Write-Host "==> Discovering the Azure AI Search service in $ResourceGroup..."
  $SearchService = az search service list -g $ResourceGroup --query "[0].name" -o tsv
  if (-not $SearchService) { throw "No Azure AI Search service found in $ResourceGroup. Deploy infra first (azd provision)." }
}
Write-Host "==> Search service: $SearchService"

if (-not $FoundryAccount) {
  Write-Host "==> Discovering the Foundry (AIServices) account in $ResourceGroup..."
  $FoundryAccount = az cognitiveservices account list -g $ResourceGroup --query "[?kind=='AIServices'] | [0].name" -o tsv
  if (-not $FoundryAccount) { throw "No AIServices account found in $ResourceGroup." }
}
Write-Host "==> Foundry account: $FoundryAccount"

if (-not $SeedDataPath) {
  $SeedDataPath = Join-Path $PSScriptRoot 'seed-data' 'microbiology.json'
}
if (-not (Test-Path $SeedDataPath)) { throw "Seed data file not found: $SeedDataPath" }

$searchEndpoint = "https://$SearchService.search.windows.net"
# AzureOpenAI endpoint form the knowledge base uses to call the reasoning model.
$openAiResourceUri = "https://$FoundryAccount.openai.azure.com/"

Write-Host "==> Fetching Azure access tokens for Search and document embeddings..."
$searchToken = az account get-access-token --resource https://search.azure.com --query accessToken -o tsv
if (-not $searchToken) { throw "Could not acquire an Azure AI Search access token. Run 'az login'." }
$foundryToken = az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv
if (-not $foundryToken) { throw "Could not acquire a Cognitive Services access token. Run 'az login' and check your RBAC on $FoundryAccount." }

$headers = @{ Authorization = "Bearer $searchToken"; 'Content-Type' = 'application/json' }

function Invoke-Search {
  param(
    [string]$Method,
    [string]$Path,
    [object]$Body
  )
  $uri = "${searchEndpoint}${Path}?api-version=${ApiVersion}"
  $json = if ($null -ne $Body) { $Body | ConvertTo-Json -Depth 20 } else { $null }
  return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -Body $json
}

# --- 1. Index -------------------------------------------------------------
Write-Host "==> Creating/updating index '$IndexName'..."
$index = @{
  name   = $IndexName
  fields = @(
    @{ name = 'id'; type = 'Edm.String'; key = $true; filterable = $true; sortable = $true }
    @{ name = 'title'; type = 'Edm.String'; searchable = $true; analyzer = 'en.microsoft' }
    @{ name = 'content'; type = 'Edm.String'; searchable = $true; analyzer = 'en.microsoft' }
    @{ name = 'subject'; type = 'Edm.String'; searchable = $true; filterable = $true; facetable = $true }
    @{ name = 'url'; type = 'Edm.String'; filterable = $true }
    @{
      name = 'contentVector'
      type = 'Collection(Edm.Single)'
      searchable = $true
      dimensions = $EmbeddingDimensions
      vectorSearchProfile = 'content-vector-profile'
    }
  )
  vectorSearch = @{
    algorithms = @(
      @{
        name = 'content-vector-hnsw'
        kind = 'hnsw'
        hnswParameters = @{ metric = 'cosine'; m = 4; efConstruction = 400; efSearch = 500 }
      }
    )
    profiles = @(
      @{ name = 'content-vector-profile'; algorithm = 'content-vector-hnsw'; vectorizer = 'content-vectorizer' }
    )
    vectorizers = @(
      @{
        name = 'content-vectorizer'
        kind = 'azureOpenAI'
        azureOpenAIParameters = @{
          resourceUri = $openAiResourceUri
          deploymentId = $EmbeddingDeployment
          modelName = $EmbeddingModelName
        }
      }
    )
  }
  semantic = @{
    defaultConfiguration = 'default'
    configurations = @(
      @{
        name = 'default'
        prioritizedFields = @{
          titleField = @{ fieldName = 'title' }
          prioritizedContentFields = @(@{ fieldName = 'content' })
          prioritizedKeywordsFields = @(@{ fieldName = 'subject' })
        }
      }
    )
  }
}
Invoke-Search -Method 'Put' -Path "/indexes('$IndexName')" -Body $index | Out-Null
Write-Host "    index ready."

# --- 2. Seed documents ----------------------------------------------------
Write-Host "==> Uploading seed documents from $SeedDataPath..."
$docs = Get-Content $SeedDataPath -Raw | ConvertFrom-Json
$embeddingInputs = @($docs | ForEach-Object { "$($_.title)`n$($_.subject)`n`n$($_.content)" })
$embeddingUri = "${openAiResourceUri}openai/deployments/${EmbeddingDeployment}/embeddings?api-version=${OpenAiApiVersion}"
$embeddingResponse = Invoke-RestMethod -Method 'Post' -Uri $embeddingUri `
  -Headers @{ Authorization = "Bearer $foundryToken"; 'Content-Type' = 'application/json' } `
  -Body (@{ input = $embeddingInputs; dimensions = $EmbeddingDimensions } | ConvertTo-Json -Depth 5)
$embeddings = @($embeddingResponse.data | Sort-Object index)
if ($embeddings.Count -ne $docs.Count) { throw "Expected $($docs.Count) embeddings but received $($embeddings.Count)." }

$actions = for ($i = 0; $i -lt $docs.Count; $i++) {
  $d = $docs[$i]
  $doc = @{ '@search.action' = 'mergeOrUpload' }
  foreach ($p in $d.PSObject.Properties) { $doc[$p.Name] = $p.Value }
  $doc.contentVector = @($embeddings[$i].embedding)
  $doc
}
Invoke-Search -Method 'Post' -Path "/indexes('$IndexName')/docs/index" -Body @{ value = $actions } | Out-Null
Write-Host "    uploaded $($actions.Count) document(s)."

# --- 3. Knowledge source --------------------------------------------------
Write-Host "==> Creating/updating knowledge source '$KnowledgeSourceName'..."
$knowledgeSource = @{
  name = $KnowledgeSourceName
  kind = 'searchIndex'
  description = 'Course materials for the EDU homework tutor.'
  searchIndexParameters = @{
    searchIndexName = $IndexName
  }
}
$ksHeaders = $headers.Clone()
$ksHeaders['Prefer'] = 'return=representation'
Invoke-RestMethod -Method 'Put' -Uri "${searchEndpoint}/knowledgesources('$KnowledgeSourceName')?api-version=$ApiVersion" `
  -Headers $ksHeaders -Body ($knowledgeSource | ConvertTo-Json -Depth 20) | Out-Null
Write-Host "    knowledge source ready."

# --- 4. Knowledge base ----------------------------------------------------
Write-Host "==> Creating/updating knowledge base '$KnowledgeBaseName'..."
$knowledgeBase = @{
  name = $KnowledgeBaseName
  description = 'EDU homework tutor course-knowledge base.'
  knowledgeSources = @(@{ name = $KnowledgeSourceName })
  models = @(
    @{
      kind = 'azureOpenAI'
      azureOpenAIParameters = @{
        resourceUri  = $openAiResourceUri
        deploymentId = $KbModelDeployment
        modelName    = $KbModelName
        # authIdentity omitted => the search service's system-assigned identity
        # is used (granted Cognitive Services OpenAI User on Foundry in Bicep).
      }
    }
  )
}
$kbHeaders = $headers.Clone()
$kbHeaders['Prefer'] = 'return=representation'
Invoke-RestMethod -Method 'Put' -Uri "${searchEndpoint}/knowledgebases('$KnowledgeBaseName')?api-version=$ApiVersion" `
  -Headers $kbHeaders -Body ($knowledgeBase | ConvertTo-Json -Depth 20) | Out-Null
Write-Host "    knowledge base ready."

Write-Host ""
Write-Host "Done. Knowledge base '$KnowledgeBaseName' is live on $searchEndpoint" -ForegroundColor Green
Write-Host "  index            : $IndexName ($($actions.Count) docs)"
Write-Host "  knowledge source : $KnowledgeSourceName"
Write-Host "  reasoning model  : $KbModelDeployment ($KbModelName)"
Write-Host "  embeddings model : $EmbeddingDeployment ($EmbeddingDimensions dimensions)"
Write-Host ""
Write-Host "Next: point the Toolbox / agent at this knowledge base (course-knowledge-connection)."
