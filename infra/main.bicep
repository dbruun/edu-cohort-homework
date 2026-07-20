targetScope = 'subscription'

@description('Location for all resources')
param location string = deployment().location

@description('Environment name for resource naming')
param environmentName string

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

output resourceGroupName string = rg.name
