// Lab resources: Foundry account + project + 3 model deployments, Application
// Insights, Azure AI Search, and an App Service professor portal with private
// policy storage.
//
// What is intentionally NOT here (vs. the full accelerator in infra/):
//   - No Container Apps environment, hosted C# agent, or ACR — the agent is
//     created in the Foundry portal during the lab.
//   - No LTI tool / Mongo sidecar — LTI is out of scope for the lab.
//
// The index / knowledge source / knowledge base are DATA-PLANE objects created
// by scripts/setup-knowledge-base.py after this deploys.

@description('Location for all resources')
param location string

@description('Short token used for resource naming')
param resourceToken string

@description('Tags applied to all resources')
param tags object

@description('SKU for Azure AI Search')
param searchSku string = 'basic'

@description('Overrides the generated App Service name. Set this when the Entra redirect URI must be registered before deployment, since the generated name contains an unpredictable hash.')
param portalAppName string = ''

param portalAuthClientId string = ''
param portalAuthKeyVaultResourceGroup string = ''
param portalAuthKeyVaultName string = ''
param portalAuthClientSecretName string = ''
@secure()
param portalAuthClientSecret string = ''
param portalAuthTenantId string = tenant().tenantId

var portalAuthEnabled = !empty(portalAuthClientId)
var portalAuthUsesKeyVault = portalAuthEnabled && empty(portalAuthClientSecret)
var portalAuthSecretSettingName = 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
var portalResourceSuffix = substring(uniqueString(resourceGroup().id), 0, 6)
var portalSiteName = empty(portalAppName) ? 'app-professor-${resourceToken}-${portalResourceSuffix}' : portalAppName
var portalPlanName = empty(portalAppName) ? 'plan-professor-${resourceToken}-${portalResourceSuffix}' : 'plan-${portalAppName}'

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

// --- Foundry monitoring --------------------------------------------------
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'logs-${resourceToken}'
  location: location
  tags: tags
  properties: {
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${resourceToken}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

// The Foundry project writes agent traces to this Application Insights
// resource and uses its managed identity to read those traces for evaluations.
resource appInsightsConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2026-05-15-preview' = {
  parent: foundryProject
  name: appInsights.name
  properties: {
    category: 'AppInsights'
    target: appInsights.id
    authType: 'ApiKey'
    isSharedToAll: true
    credentials: {
      key: appInsights.properties.ConnectionString
    }
    metadata: {
      ApiType: 'Azure'
      ResourceId: appInsights.id
    }
  }
}

var logAnalyticsReaderRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '73c42c96-874c-492b-b04d-ab87d138a893')

resource projectLogAnalyticsReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(appInsights.id, foundryProject.id, logAnalyticsReaderRoleId)
  scope: appInsights
  properties: {
    principalId: foundryProject.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: logAnalyticsReaderRoleId
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

module searchOpenAIRole './foundry-role.bicep' = {
  name: 'search-openai-role'
  params: {
    accountName: foundry.name
    principalId: search.identity.principalId
    roleDefinitionId: openAIUserRoleId
  }
}

var searchIndexDataReaderRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '1407120a-92aa-4202-b7e9-c0e197c71c8f')

// When the agent's knowledge base is attached in the portal, retrieval runs
// through the PROJECT managed identity (the KB-MCP connection uses
// ProjectManagedIdentity auth), so the project identity needs data-plane read
// on the search service. Pre-granting it here means the portal "attach the
// knowledge base" step just works — no RBAC troubleshooting during the lab.
module projectSearchRole './search-role.bicep' = {
  name: 'project-search-role'
  params: {
    searchServiceName: search.name
    principalId: foundryProject.identity.principalId
    roleDefinitionId: searchIndexDataReaderRoleId
  }
}

// If an attendee instead attaches the search index via the account-level AAD
// connection (azure_ai_search tool), that path authenticates as the AI Services
// ACCOUNT identity — grant it read too so either portal path works.
module accountSearchRole './search-role.bicep' = {
  name: 'account-search-role'
  params: {
    searchServiceName: search.name
    principalId: foundry.identity.principalId
    roleDefinitionId: searchIndexDataReaderRoleId
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
    publicNetworkAccess: 'Enabled'
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

// Raw .imscc uploads are archived here for durability; no indexer runs over it.
resource courseContentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: policyBlobService
  name: 'course-content'
  properties: {
    publicAccess: 'None'
  }
}

resource portalPlan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: portalPlanName
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
  name: portalSiteName
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
      appCommandLine: 'npm start'
      ftpsState: 'Disabled'
      linuxFxVersion: 'NODE|22-lts'
      minTlsVersion: '1.2'
      appSettings: concat([
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
          value: 'course-content-index'
        }
        {
          name: 'COURSE_CONTENT_CONTAINER'
          value: 'course-content'
        }
        {
          name: 'POLICY_INDEXER_NAME'
          value: 'pedagogy-policy-idxr'
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
      ], portalAuthEnabled ? [
        {
          name: portalAuthSecretSettingName
          value: portalAuthUsesKeyVault ? '@Microsoft.KeyVault(VaultName=${portalAuthKeyVaultName};SecretName=${portalAuthClientSecretName})' : portalAuthClientSecret
        }
      ] : [])
    }
  }
}

resource portalAuth 'Microsoft.Web/sites/config@2024-04-01' = if (portalAuthEnabled) {
  parent: portal
  name: 'authsettingsV2'
  properties: {
    platform: {
      enabled: true
      runtimeVersion: '~1'
    }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          openIdIssuer: '${environment().authentication.loginEndpoint}${portalAuthTenantId}/v2.0'
          clientId: portalAuthClientId
          clientSecretSettingName: portalAuthSecretSettingName
        }
        validation: {
          allowedAudiences: [portalAuthClientId]
        }
      }
    }
    login: {
      tokenStore: {
        enabled: true
      }
    }
    httpSettings: {
      requireHttps: true
      routes: {
        apiPrefix: '/.auth'
      }
    }
  }
}

module portalKeyVaultRole './portal-key-vault-role.bicep' = if (portalAuthUsesKeyVault) {
  scope: resourceGroup(portalAuthKeyVaultResourceGroup)
  params: {
    keyVaultName: portalAuthKeyVaultName
    principalId: portal.identity.principalId
  }
}

var storageBlobDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var storageBlobDataReaderRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')

// The policy blob indexer reads the 'policies' container as the search service identity.
module searchStorageReadRole './storage-role.bicep' = {
  name: 'search-storage-read-role'
  params: {
    storageAccountName: policyStorage.name
    principalId: search.identity.principalId
    roleDefinitionId: storageBlobDataReaderRoleId
  }
}

// The portal creates the course-content index on upload and runs the policy indexer.
module portalSearchServiceRole './search-role.bicep' = {
  name: 'portal-search-service-role'
  params: {
    searchServiceName: search.name
    principalId: portal.identity.principalId
    roleDefinitionId: searchServiceContributorRoleId
  }
}

module portalStorageRole './storage-role.bicep' = {
  name: 'portal-storage-role'
  params: {
    storageAccountName: policyStorage.name
    principalId: portal.identity.principalId
    roleDefinitionId: storageBlobDataContributorRoleId
  }
}

module portalSearchDataRole './search-role.bicep' = {
  name: 'portal-search-role'
  params: {
    searchServiceName: search.name
    principalId: portal.identity.principalId
    roleDefinitionId: searchIndexDataContributorRoleId
  }
}

module portalOpenAIRole './foundry-role.bicep' = {
  name: 'portal-openai-role'
  params: {
    accountName: foundry.name
    principalId: portal.identity.principalId
    roleDefinitionId: openAIUserRoleId
  }
}

output foundryAccountName string = foundry.name
output foundryProjectName string = foundryProject.name
output foundryProjectEndpoint string = 'https://${foundry.name}.services.ai.azure.com/api/projects/${foundryProject.name}'
output applicationInsightsName string = appInsights.name
output applicationInsightsResourceId string = appInsights.id
output applicationInsightsConnectionString string = appInsights.properties.ConnectionString
output searchServiceName string = search.name
output searchEndpoint string = searchEndpoint
output chatDeploymentName string = chatModelDeployment.name
output kbReasoningDeploymentName string = kbReasoningDeployment.name
output embeddingDeploymentName string = embeddingDeployment.name
output portalAppName string = portal.name
output portalUrl string = 'https://${portal.properties.defaultHostName}'
output policyStorageAccountName string = policyStorage.name
