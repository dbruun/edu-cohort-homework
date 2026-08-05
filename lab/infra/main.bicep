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
  }
}

output AZURE_LOCATION string = location
output RESOURCE_GROUP_NAME string = rg.name
output AZURE_RESOURCE_GROUP string = rg.name
output FOUNDRY_ACCOUNT_NAME string = resources.outputs.foundryAccountName
output FOUNDRY_PROJECT_NAME string = resources.outputs.foundryProjectName
output FOUNDRY_PROJECT_ENDPOINT string = resources.outputs.foundryProjectEndpoint
output SEARCH_SERVICE_NAME string = resources.outputs.searchServiceName
output SEARCH_ENDPOINT string = resources.outputs.searchEndpoint
output CHAT_DEPLOYMENT_NAME string = resources.outputs.chatDeploymentName
output KB_REASONING_DEPLOYMENT_NAME string = resources.outputs.kbReasoningDeploymentName
output EMBEDDING_DEPLOYMENT_NAME string = resources.outputs.embeddingDeploymentName
output PORTAL_APP_NAME string = resources.outputs.portalAppName
output PORTAL_URL string = resources.outputs.portalUrl
output POLICY_STORAGE_ACCOUNT string = resources.outputs.policyStorageAccountName
