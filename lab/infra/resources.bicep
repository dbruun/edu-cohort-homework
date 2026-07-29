// Slim lab resources: Foundry account + project + 3 model deployments, and an
// Azure AI Search service wired for portal knowledge-base grounding.
//
// What is intentionally NOT here (vs. the full accelerator in infra/):
//   - No Container Apps environment, hosted C# agent, or ACR — the agent is
//     created in the Foundry portal during the lab.
//   - No LTI tool / Mongo sidecar — LTI is out of scope for the lab.
//   - No Log Analytics / App Insights — not needed to stand up the agent.
//
// The index / knowledge source / knowledge base are DATA-PLANE objects created
// by scripts/setup-knowledge-base.ps1 after this deploys.

@description('Location for all resources')
param location string

@description('Short token used for resource naming')
param resourceToken string

@description('Tags applied to all resources')
param tags object

@description('SKU for Azure AI Search')
param searchSku string = 'basic'

// --- Foundry (Azure AI Services) account + project ------------------------
resource foundry 'Microsoft.CognitiveServices/accounts@2026-05-15-preview' = {
  name: 'aif-${resourceToken}'
  location: location
  tags: tags
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: 'aif-${resourceToken}'
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: false
    // Required so a Foundry project can be created under this AIServices account.
    allowProjectManagement: true
  }
}

resource foundryProject 'Microsoft.CognitiveServices/accounts/projects@2026-05-15-preview' = {
  parent: foundry
  name: 'homework'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    displayName: 'Homework Tutor'
    description: 'EDU homework tutor lab project.'
  }
}

// Chat model the agent uses to talk to students.
resource chatModelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: foundry
  name: 'gpt-5.4'
  sku: {
    name: 'GlobalStandard'
    capacity: 50
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-5.4'
      version: '2026-03-05'
    }
  }
}

// Small, cheap model the Azure AI Search knowledge base uses for query planning
// and answer synthesis (agentic retrieval). Serialized after the chat model —
// the account rejects concurrent deployment creates.
resource kbReasoningDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: foundry
  name: 'gpt-5.4-mini'
  dependsOn: [
    chatModelDeployment
  ]
  sku: {
    name: 'GlobalStandard'
    capacity: 50
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-5.4-mini'
      version: '2026-03-17'
    }
  }
}

// Embeddings model used both while the loader pushes course documents and by
// Azure AI Search to vectorize queries at retrieval time.
resource embeddingDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: foundry
  name: 'text-embedding-3-small'
  dependsOn: [
    kbReasoningDeployment
  ]
  sku: {
    name: 'GlobalStandard'
    capacity: 50
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'text-embedding-3-small'
      version: '1'
    }
  }
}

// --- Azure AI Search ------------------------------------------------------
resource search 'Microsoft.Search/searchServices@2024-06-01-preview' = {
  name: 'srch-${resourceToken}'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: searchSku
  }
  properties: {
    replicaCount: 1
    partitionCount: 1
    hostingMode: 'default'
    // 'free' semantic ranker is enough for the lab and is required by the
    // semantic configuration the loader script creates.
    semanticSearch: 'free'
    publicNetworkAccess: 'enabled'
    disableLocalAuth: false
  }
}

var searchEndpoint = 'https://${search.name}.search.windows.net'

// The search service calls the KB reasoning model; its system-assigned identity
// needs OpenAI access on Foundry.
var openAIUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
var searchServiceContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7ca78c08-252a-4471-8644-bb5ff32d4ba0')
var searchIndexDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8ebe5a00-799e-43f5-93ac-243d3dce84a7')
var deployingPrincipalId = deployer().objectId

// The setup scripts run as the signed-in attendee. These grants let that user
// create Search data-plane objects, upload documents, and generate embeddings
// without enabling account keys.
resource deployerOpenAIRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, deployingPrincipalId, openAIUserRoleId)
  scope: foundry
  properties: {
    principalId: deployingPrincipalId
    roleDefinitionId: openAIUserRoleId
    principalType: 'User'
  }
}

resource deployerSearchServiceRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, deployingPrincipalId, searchServiceContributorRoleId)
  scope: search
  properties: {
    principalId: deployingPrincipalId
    roleDefinitionId: searchServiceContributorRoleId
    principalType: 'User'
  }
}

resource deployerSearchDataRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, deployingPrincipalId, searchIndexDataContributorRoleId)
  scope: search
  properties: {
    principalId: deployingPrincipalId
    roleDefinitionId: searchIndexDataContributorRoleId
    principalType: 'User'
  }
}

resource searchOpenAIRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, search.id, openAIUserRoleId)
  scope: foundry
  properties: {
    principalId: search.identity.principalId
    roleDefinitionId: openAIUserRoleId
    principalType: 'ServicePrincipal'
  }
}

var searchIndexDataReaderRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '1407120a-92aa-4202-b7e9-c0e197c71c8f')

// When the agent's knowledge base is attached in the portal, retrieval runs
// through the PROJECT managed identity (the KB-MCP connection uses
// ProjectManagedIdentity auth), so the project identity needs data-plane read
// on the search service. Pre-granting it here means the portal "attach the
// knowledge base" step just works — no RBAC troubleshooting during the lab.
resource projectSearchRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, foundryProject.id, searchIndexDataReaderRoleId)
  scope: search
  properties: {
    principalId: foundryProject.identity.principalId
    roleDefinitionId: searchIndexDataReaderRoleId
    principalType: 'ServicePrincipal'
  }
}

// If an attendee instead attaches the search index via the account-level AAD
// connection (azure_ai_search tool), that path authenticates as the AI Services
// ACCOUNT identity — grant it read too so either portal path works.
resource accountSearchRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, foundry.id, searchIndexDataReaderRoleId)
  scope: search
  properties: {
    principalId: foundry.identity.principalId
    roleDefinitionId: searchIndexDataReaderRoleId
    principalType: 'ServicePrincipal'
  }
}

// Foundry project connection to the search service (AAD, no keys). Gives the
// portal "Add knowledge" wizard a ready-made connection to select.
resource searchConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2026-05-15-preview' = {
  parent: foundryProject
  name: 'course-knowledge-connection'
  properties: {
    category: 'CognitiveSearch'
    target: searchEndpoint
    authType: 'AAD'
    isSharedToAll: true
    metadata: {
      ApiType: 'Azure'
      ResourceId: search.id
      Location: location
    }
  }
}

output foundryAccountName string = foundry.name
output foundryProjectName string = foundryProject.name
output foundryProjectEndpoint string = 'https://${foundry.name}.services.ai.azure.com/api/projects/${foundryProject.name}'
output searchServiceName string = search.name
output searchEndpoint string = searchEndpoint
output chatDeploymentName string = chatModelDeployment.name
output kbReasoningDeploymentName string = kbReasoningDeployment.name
output embeddingDeploymentName string = embeddingDeployment.name
