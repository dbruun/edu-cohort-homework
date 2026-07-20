targetScope = 'subscription'

@description('Location for all resources')
param location string = deployment().location

@description('Environment name for resource naming')
param environmentName string

@description('Foundry project endpoint for the hosted agent runtime')
param foundryProjectEndpoint string = ''

@description('MCP endpoint for the Foundry Toolbox')
param toolboxEndpoint string = ''

@description('Model deployment the agent invokes')
param modelDeploymentName string = 'gpt-4o'

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
    foundryProjectEndpoint: foundryProjectEndpoint
    toolboxEndpoint: toolboxEndpoint
    modelDeploymentName: modelDeploymentName
  }
}

output AZURE_LOCATION string = location
output RESOURCE_GROUP_NAME string = rg.name
output HOMEWORK_AGENT_URL string = resources.outputs.homeworkAgentUrl
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.containerRegistryLoginServer

