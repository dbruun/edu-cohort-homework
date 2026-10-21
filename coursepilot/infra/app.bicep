targetScope = 'resourceGroup'

param environmentName string
param location string
param portalPlanName string
param foundryAccountName string
param foundryProjectName string
param agentName string
param agentVersion string
param authClientId string
param authKeyVaultName string
param authSecretName string
param workspaceName string
param policyStorageAccountName string

resource policyStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: policyStorageAccountName
}
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: policyStorage
  name: 'default'
}
resource policies 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: blobService
  name: 'policies'
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' existing = {
  name: portalPlanName
}
resource foundry 'Microsoft.CognitiveServices/accounts@2026-05-15-preview' existing = {
  name: foundryAccountName
}
resource project 'Microsoft.CognitiveServices/accounts/projects@2026-05-15-preview' existing = {
  parent: foundry
  name: foundryProjectName
}
resource vault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: authKeyVaultName
}
resource secret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = {
  parent: vault
  name: authSecretName
}
resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: workspaceName
}

var siteName = 'app-coursepilot-${substring(uniqueString(resourceGroup().id), 0, 6)}'
var secretSetting = 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
var keyVaultSecretsUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var foundryUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '53ca6127-db72-4b80-b1b0-d745d6d5456d')

resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: siteName
  location: location
  kind: 'app,linux'
  tags: {
    environment: environmentName
    workload: 'coursepilot'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      alwaysOn: true
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'npm start'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
        { name: 'FOUNDRY_PROJECT_ENDPOINT', value: 'https://${foundry.name}.services.ai.azure.com/api/projects/${project.name}' }
        { name: 'FOUNDRY_AGENT_NAME', value: agentName }
        { name: 'FOUNDRY_AGENT_VERSION', value: agentVersion }
        { name: 'POLICY_STORAGE_ACCOUNT', value: policyStorageAccountName }
        { name: secretSetting, value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=${secret.name})' }
      ]
    }
  }
}

resource auth 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: site
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true, runtimeVersion: '~1' }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
          clientId: authClientId
          clientSecretSettingName: secretSetting
        }
        validation: { allowedAudiences: [authClientId] }
      }
    }
    login: { tokenStore: { enabled: true } }
    httpSettings: {
      requireHttps: true
      routes: { apiPrefix: '/.auth' }
    }
  }
}

resource vaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: secret
  name: guid(secret.id, site.id, keyVaultSecretsUserRoleId)
  properties: {
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleId
  }
}
resource agentRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: project
  name: guid(project.id, site.id, foundryUserRoleId)
  properties: {
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: foundryUserRoleId
  }
}
resource policyReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: policies
  name: guid(policies.id, site.id, 'policy-reader')
  properties: {
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
  }
}
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: site
  name: 'send-to-log-analytics'
  properties: {
    workspaceId: workspace.id
    logs: [
      { category: 'AppServiceConsoleLogs', enabled: true }
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServicePlatformLogs', enabled: true }
    ]
  }
}
resource logs 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: site
  name: 'logs'
  properties: {
    applicationLogs: { fileSystem: { level: 'Information' } }
    httpLogs: { fileSystem: { enabled: true, retentionInDays: 7, retentionInMb: 35 } }
  }
}

output appName string = site.name
output url string = 'https://${site.properties.defaultHostName}'
