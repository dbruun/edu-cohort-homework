targetScope = 'subscription'

@description('Location for all resources')
param location string = deployment().location

@description('Environment name for resource naming')
param environmentName string

@description('MCP endpoint for the Foundry Toolbox')
param toolboxEndpoint string = ''

@description('Model deployment the agent invokes')
param modelDeploymentName string = 'gpt-5.4'

@secure()
@description('Encryption key used by the ltijs LTI tool for cookies/state. Defaults to a new GUID.')
param ltiEncryptionKey string = newGuid()
@secure()
@description('Admin password for the self-hosted MongoDB used by the LTI tool. Defaults to a new GUID.')
param mongoAdminPassword string = newGuid()
var resourceToken = toLower(replace(environmentName, '-', ''))
var tags = {
  environment: environmentName
  workload: 'edu-homework-accelerator'
}

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${resourceToken}'
  location: location
  tags: tags
}

module resources 'resources.bicep' = {
  name: 'resources'
  scope: rg
  params: {
    location: location
    resourceToken: resourceToken
    tags: tags
    toolboxEndpoint: toolboxEndpoint
    modelDeploymentName: modelDeploymentName
    ltiEncryptionKey: ltiEncryptionKey
    mongoAdminPassword: mongoAdminPassword
  }
}

output AZURE_LOCATION string = location
output RESOURCE_GROUP_NAME string = rg.name
output HOMEWORK_AGENT_URL string = resources.outputs.homeworkAgentUrl
output LTI_TOOL_URL string = resources.outputs.ltiToolUrl
output FOUNDRY_PROJECT_ENDPOINT string = resources.outputs.foundryProjectEndpoint
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.containerRegistryLoginServer

