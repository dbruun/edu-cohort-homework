// Lab resources: Foundry account + project + 3 model deployments, Azure AI
// Search, and an App Service professor portal with private policy storage.
//
// What is intentionally NOT here (vs. the full accelerator in infra/):
//   - No Container Apps environment, hosted C# agent, or ACR — the agent is
//     created in the Foundry portal during the lab.
//   - No LTI tool / Mongo sidecar — LTI is out of scope for the lab.
//   - No Log Analytics / App Insights — not needed for the hands-on flow.
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
    authOptions: {
      aadOrApiKey: {
        aadAuthFailureMode: 'http403'
      }
    }
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

// --- Professor portal (App Service) --------------------------------------
resource policyStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'st${uniqueString(resourceGroup().id)}'
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource policyBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: policyStorage
  name: 'default'
}

resource policyContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: policyBlobService
  name: 'policies'
  properties: {
    publicAccess: 'None'
  }
}

resource portalPlan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: 'plan-professor-${resourceToken}'
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  properties: {
    reserved: true
  }
}

resource portal 'Microsoft.Web/sites@2024-04-01' = {
  name: 'app-professor-${resourceToken}'
  location: location
  tags: tags
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: portalPlan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      alwaysOn: true
      ftpsState: 'Disabled'
      linuxFxVersion: 'NODE|22-lts'
      minTlsVersion: '1.2'
      appSettings: [
        {
          name: 'POLICY_STORAGE_ACCOUNT'
          value: policyStorage.name
        }
        {
          name: 'SEARCH_ENDPOINT'
          value: searchEndpoint
        }
        {
          name: 'SEARCH_INDEX_NAME'
          value: 'course-materials'
        }
        {
          name: 'OPENAI_ENDPOINT'
          value: 'https://${foundry.name}.openai.azure.com'
        }
        {
          name: 'EMBEDDING_DEPLOYMENT'
          value: embeddingDeployment.name
        }
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
      ]
    }
  }
}

var storageBlobDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

resource portalStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(policyStorage.id, portal.id, storageBlobDataContributorRoleId)
  scope: policyStorage
  properties: {
    principalId: portal.identity.principalId
    roleDefinitionId: storageBlobDataContributorRoleId
    principalType: 'ServicePrincipal'
  }
}

resource portalSearchDataRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, portal.id, searchIndexDataContributorRoleId)
  scope: search
  properties: {
    principalId: portal.identity.principalId
    roleDefinitionId: searchIndexDataContributorRoleId
    principalType: 'ServicePrincipal'
  }
}

resource portalOpenAIRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, portal.id, openAIUserRoleId)
  scope: foundry
  properties: {
    principalId: portal.identity.principalId
    roleDefinitionId: openAIUserRoleId
    principalType: 'ServicePrincipal'
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
output portalAppName string = portal.name
output portalUrl string = 'https://${portal.properties.defaultHostName}'
output policyStorageAccountName string = policyStorage.name
