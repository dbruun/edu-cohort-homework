targetScope = 'subscription'

param environmentName string
param resourceGroupName string
param location string
param portalPlanName string
param foundryAccountName string
param foundryProjectName string
param agentName string
param agentVersion string
@minLength(36)
param authClientId string
param authKeyVaultName string
param authSecretName string
param workspaceName string
param policyStorageAccountName string

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' existing = {
  name: resourceGroupName
}

module app 'app.bicep' = {
  name: '${environmentName}-app'
  scope: rg
  params: {
    environmentName: environmentName
    location: location
    portalPlanName: portalPlanName
    foundryAccountName: foundryAccountName
    foundryProjectName: foundryProjectName
    agentName: agentName
    agentVersion: agentVersion
    authClientId: authClientId
    authKeyVaultName: authKeyVaultName
    authSecretName: authSecretName
    workspaceName: workspaceName
    policyStorageAccountName: policyStorageAccountName
  }
}

output AZURE_RESOURCE_GROUP string = rg.name
output COURSEPILOT_APP_NAME string = app.outputs.appName
output SERVICE_COURSEPILOT_RESOURCE_NAME string = app.outputs.appName
output COURSEPILOT_URL string = app.outputs.url
output COURSEPILOT_REDIRECT_URI string = '${app.outputs.url}/.auth/login/aad/callback'
