<#
.SYNOPSIS
  Creates the two knowledge bases the tutor agent consults: course content and
  pedagogy policy. Each gets its own knowledge source over its own index.

.DESCRIPTION
  Two knowledge bases, not one base with two sources. The agent must be able to
  retrieve the professor's policy WITHOUT also pulling course content, so that
  "read the policy first" is a separate, observable tool call in the run trace
  rather than an implementation detail buried inside a single retrieval.

    pedagogy-policy-base  -> pedagogy-policy-source  -> pedagogy-policy-index
    course-knowledge-base -> course-content-source   -> course-content-index

  The policy index and its indexer are built by setup-policy-ingestion.ps1.
  This script owns the course-content index because the professor portal only
  uploads documents into it (ui/api/documents.js) and never creates it.

  The course-content index schema is dictated by the portal: it pushes
  { id, title, content, subject, url } plus a 1536-dimension `contentVector`.
  The vectorizer lets the knowledge base turn a text question into a vector at
  query time; index-time vectors come from the portal.

  Idempotent (PUT / createOrUpdate); safe to re-run.

.PARAMETER EnvironmentName
  azd environment name. Used to derive the resource group (rg-<token>) and to
  auto-discover the search service and Foundry account.

.EXAMPLE
  ./scripts/setup-knowledge-bases.ps1 -EnvironmentName cohort-demo
#>
[CmdletBinding()]
param(
  [string]$EnvironmentName,
  [string]$ResourceGroup,
  [string]$SearchService,
  [string]$FoundryAccount,
  [string]$CourseIndexName = 'course-content-index',
  [string]$CourseSourceName = 'course-content-source',
  [string]$CourseBaseName = 'course-knowledge-base',
  [string]$PolicyIndexName = 'pedagogy-policy-index',
  [string]$PolicySourceName = 'pedagogy-policy-source',
  [string]$PolicyBaseName = 'pedagogy-policy-base',
  [string]$KbModelDeployment = 'gpt-5.4-mini',
  [ValidateSet('gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-5-nano')]
  [string]$KbModelName = 'gpt-5.4-mini',
  [string]$EmbeddingDeployment = 'text-embedding-3-small',
  [string]$EmbeddingModelName = 'text-embedding-3-small',
  [int]$EmbeddingDimensions = 1536,
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
if (-not $FoundryAccount) {
  $FoundryAccount = az cognitiveservices account list -g $ResourceGroup --query "[?kind=='AIServices'] | [0].name" -o tsv
  if (-not $FoundryAccount) { throw "No AIServices (Foundry) account found in $ResourceGroup." }
}
$searchEndpoint = "https://$SearchService.search.windows.net"
$openAiEndpoint = "https://$FoundryAccount.openai.azure.com/"
Write-Host "==> Search: $SearchService | Foundry: $FoundryAccount"

$token = az account get-access-token --resource https://search.azure.com --query accessToken -o tsv
if (-not $token) { throw "Could not acquire an Azure AI Search token. Run 'az login'." }
$headers = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }

function Invoke-Search {
  param([string]$Method, [string]$Path, [object]$Body)
  $uri = "${searchEndpoint}${Path}?api-version=${ApiVersion}"
  $json = if ($null -ne $Body) { $Body | ConvertTo-Json -Depth 30 } else { $null }
  return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -Body $json
}

# --- 1. Course-content index ---------------------------------------------
# Field names and the vector dimension must match ui/api/documents.js exactly,
# or the portal's IMSCC upload fails against this index.
Write-Host "==> Creating/updating index '$CourseIndexName'..."
$courseIndex = @{
  name   = $CourseIndexName
  fields = @(
    @{ name = 'id'; type = 'Edm.String'; key = $true; filterable = $true; analyzer = 'keyword' }
    @{ name = 'title'; type = 'Edm.String'; searchable = $true; retrievable = $true; analyzer = 'en.microsoft' }
    @{ name = 'content'; type = 'Edm.String'; searchable = $true; retrievable = $true; analyzer = 'en.microsoft' }
    @{ name = 'subject'; type = 'Edm.String'; searchable = $true; filterable = $true; facetable = $true; retrievable = $true }
    @{ name = 'url'; type = 'Edm.String'; retrievable = $true }
    @{
      name                = 'contentVector'
      type                = 'Collection(Edm.Single)'
      searchable          = $true
      retrievable         = $false
      dimensions          = $EmbeddingDimensions
      vectorSearchProfile = 'default'
    }
  )
  vectorSearch = @{
    algorithms  = @(@{ name = 'hnsw'; kind = 'hnsw' })
    vectorizers = @(@{
        name                  = 'openai-vectorizer'
        kind                  = 'azureOpenAI'
        azureOpenAIParameters = @{
          resourceUri  = $openAiEndpoint
          deploymentId = $EmbeddingDeployment
          modelName    = $EmbeddingModelName
        }
      })
    profiles    = @(@{ name = 'default'; algorithm = 'hnsw'; vectorizer = 'openai-vectorizer' })
  }
  semantic = @{
    defaultConfiguration = 'default'
    configurations       = @(@{
        name              = 'default'
        prioritizedFields = @{
          titleField               = @{ fieldName = 'title' }
          prioritizedContentFields = @(@{ fieldName = 'content' })
          prioritizedKeywordsFields = @(@{ fieldName = 'subject' })
        }
      })
  }
}
Invoke-Search -Method 'Put' -Path "/indexes('$CourseIndexName')" -Body $courseIndex | Out-Null
Write-Host '    index ready.'

# --- 2. Knowledge sources -------------------------------------------------
foreach ($pair in @(
    @{ Source = $CourseSourceName; Index = $CourseIndexName },
    @{ Source = $PolicySourceName; Index = $PolicyIndexName }
  )) {
  Write-Host "==> Creating/updating knowledge source '$($pair.Source)' over '$($pair.Index)'..."
  $knowledgeSource = @{
    name                 = $pair.Source
    kind                 = 'searchIndex'
    searchIndexParameters = @{ searchIndexName = $pair.Index }
  }
  Invoke-Search -Method 'Put' -Path "/knowledgesources('$($pair.Source)')" -Body $knowledgeSource | Out-Null
  Write-Host '    knowledge source ready.'
}

# --- 3. Knowledge bases ---------------------------------------------------
# authIdentity is omitted so the search service's system-assigned identity is
# used to call the model; it holds Cognitive Services OpenAI User on Foundry.
foreach ($pair in @(
    @{ Base = $CourseBaseName; Source = $CourseSourceName },
    @{ Base = $PolicyBaseName; Source = $PolicySourceName }
  )) {
  Write-Host "==> Creating/updating knowledge base '$($pair.Base)'..."
  $knowledgeBase = @{
    name             = $pair.Base
    knowledgeSources = @(@{ name = $pair.Source })
    models           = @(@{
        kind                  = 'azureOpenAI'
        azureOpenAIParameters = @{
          resourceUri  = $openAiEndpoint
          deploymentId = $KbModelDeployment
          modelName    = $KbModelName
        }
      })
  }
  Invoke-Search -Method 'Put' -Path "/knowledgebases('$($pair.Base)')" -Body $knowledgeBase | Out-Null
  Write-Host '    knowledge base ready.'
}

# --- 4. Report ------------------------------------------------------------
Write-Host ''
Write-Host '==> Knowledge bases:'
foreach ($pair in @(
    @{ Base = $PolicyBaseName; Index = $PolicyIndexName },
    @{ Base = $CourseBaseName; Index = $CourseIndexName }
  )) {
  $count = try {
    Invoke-RestMethod -Uri "$searchEndpoint/indexes/$($pair.Index)/docs/`$count?api-version=$ApiVersion" -Headers $headers
  }
  catch { 'unknown' }
  Write-Host "    $($pair.Base) -> $($pair.Index) ($count documents)"
}
Write-Host ''
Write-Host 'A knowledge base with 0 documents answers nothing. Load course'
Write-Host 'content by importing an IMSCC file in the professor portal.'
