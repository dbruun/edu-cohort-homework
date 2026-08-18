// Subscription-scoped entry point for the HANDS-ON LAB infrastructure.
//
// Provisions ONLY what the lab needs: a Foundry (Azure AI Services) account +
// project, three model deployments (chat + KB reasoning + embeddings), and an Azure AI Search
// service with the RBAC + connection required for portal knowledge-base
// grounding. It deliberately does NOT deploy the C# hosted agent container, the
// LTI tool, ACR, or Mongo — attendees create the agent in the Foundry portal and
// (optionally) run the AG-UI bridge locally.
//
// Deploy with: lab/deploy.ps1  (or lab/deploy.sh), which wraps
//   az deployment sub create --location <loc> --template-file lab/infra/main.bicep
targetScope = 'subscription'

@description('Environment name — used for resource naming (rg-<token>, aif-<token>, srch-<token>).')
param environmentName string

@description('Location for all resources. Must have gpt-5.4, gpt-5.4-mini, and text-embedding-3-small quota (northcentralus recommended).')
param location string = deployment().location

@description('SKU for Azure AI Search. \'basic\' is right for the lab; \'standard\' (S1)+ for go-live.')
@allowed([
  'basic'
  'standard'
  'standard2'
  'standard3'
])
param searchSku string = 'basic'

@description('Overrides the generated App Service name so the Easy Auth redirect URI can be registered before deployment. Required when attendees cannot edit the Entra app registration themselves.')
param portalAppName string = ''

@description('Application (client) ID of the existing tenant-only Entra app registration used by professor portal Easy Auth. Leave empty to disable Easy Auth configuration.')
param portalAuthClientId string = ''

@description('Resource group containing the existing Key Vault with the Entra client secret.')
param portalAuthKeyVaultResourceGroup string = ''

@description('Name of the existing Key Vault with the Entra client secret.')
param portalAuthKeyVaultName string = ''

@description('Name of the Key Vault secret containing the Entra client secret.')
param portalAuthClientSecretName string = ''

@description('Entra client secret value. Supply this OR the Key Vault parameters; Key Vault is preferred.')
@secure()
param portalAuthClientSecret string = ''

@description('Tenant ID used by the professor portal Entra issuer.')
param portalAuthTenantId string = tenant().tenantId

var resourceToken = toLower(replace(environmentName, '-', ''))
var tags = {
  environment: environmentName
  workload: 'edu-homework-lab'
}

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${resourceToken}'
  location: location
  tags: tags
}

module resources 'resources.bicep' = {
  name: 'lab-resources'
  scope: rg
  params: {
    location: location
    resourceToken: resourceToken
    tags: tags
    searchSku: searchSku
    portalAppName: portalAppName
    portalAuthClientId: portalAuthClientId
    portalAuthKeyVaultResourceGroup: portalAuthKeyVaultResourceGroup
    portalAuthKeyVaultName: portalAuthKeyVaultName
    portalAuthClientSecretName: portalAuthClientSecretName
    portalAuthClientSecret: portalAuthClientSecret
    portalAuthTenantId: portalAuthTenantId
  }
}

output AZURE_LOCATION string = location
output RESOURCE_GROUP_NAME string = rg.name
output AZURE_RESOURCE_GROUP string = rg.name
output FOUNDRY_ACCOUNT_NAME string = resources.outputs.foundryAccountName
output FOUNDRY_PROJECT_NAME string = resources.outputs.foundryProjectName
output FOUNDRY_PROJECT_ENDPOINT string = resources.outputs.foundryProjectEndpoint
output APPLICATIONINSIGHTS_NAME string = resources.outputs.applicationInsightsName
output APPLICATIONINSIGHTS_RESOURCE_ID string = resources.outputs.applicationInsightsResourceId
output APPLICATIONINSIGHTS_CONNECTION_STRING string = resources.outputs.applicationInsightsConnectionString
output SEARCH_SERVICE_NAME string = resources.outputs.searchServiceName
output SEARCH_ENDPOINT string = resources.outputs.searchEndpoint
output CHAT_DEPLOYMENT_NAME string = resources.outputs.chatDeploymentName
output KB_REASONING_DEPLOYMENT_NAME string = resources.outputs.kbReasoningDeploymentName
output EMBEDDING_DEPLOYMENT_NAME string = resources.outputs.embeddingDeploymentName
output PORTAL_APP_NAME string = resources.outputs.portalAppName
output SERVICE_PROFESSOR_PORTAL_RESOURCE_NAME string = resources.outputs.portalAppName
output PORTAL_URL string = resources.outputs.portalUrl
output POLICY_STORAGE_ACCOUNT string = resources.outputs.policyStorageAccountName
