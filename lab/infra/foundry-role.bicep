targetScope = 'resourceGroup'

param accountName string
param principalId string
param roleDefinitionId string

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: accountName
}

resource role 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, principalId, roleDefinitionId)
  scope: account
  properties: {
    principalId: principalId
    roleDefinitionId: roleDefinitionId
    principalType: 'ServicePrincipal'
  }
}
