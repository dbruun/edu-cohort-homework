targetScope = 'resourceGroup'

param searchServiceName string
param principalId string
param roleDefinitionId string

resource search 'Microsoft.Search/searchServices@2025-05-01' existing = {
  name: searchServiceName
}

resource role 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, principalId, roleDefinitionId)
  scope: search
  properties: {
    principalId: principalId
    roleDefinitionId: roleDefinitionId
    principalType: 'ServicePrincipal'
  }
}
