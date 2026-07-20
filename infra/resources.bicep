@description('Location for all resources')
param location string

@description('Short token used for resource naming')
param resourceToken string

@description('Tags applied to all resources')
param tags object

@description('Foundry project endpoint for the hosted agent runtime')
param foundryProjectEndpoint string = ''

@description('MCP endpoint for the Foundry Toolbox')
param toolboxEndpoint string = ''

@description('Model deployment the agent invokes')
param modelDeploymentName string = 'gpt-4o'

var agentServiceName = 'homework-agent'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${resourceToken}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
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

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${resourceToken}'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: 'acr${resourceToken}${uniqueString(resourceGroup().id)}'
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, acrPullRoleId)
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    roleDefinitionId: acrPullRoleId
    principalType: 'ServicePrincipal'
  }
}

resource managedEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${resourceToken}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource agentApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${agentServiceName}-${resourceToken}'
  location: location
  tags: union(tags, {
    'azd-service-name': agentServiceName
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnv.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: agentServiceName
          image: 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsights.properties.ConnectionString
            }
            {
              name: 'FOUNDRY_PROJECT_ENDPOINT'
              value: foundryProjectEndpoint
            }
            {
              name: 'TOOLBOX_ENDPOINT'
              value: toolboxEndpoint
            }
            {
              name: 'AZURE_AI_MODEL_DEPLOYMENT_NAME'
              value: modelDeploymentName
            }
            {
              name: 'PEDAGOGY_POLICY_URI'
              value: './Pedagogy/pedagogy-policy.json'
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
      }
    }
  }
}

output homeworkAgentUrl string = 'https://${agentApp.properties.configuration.ingress.fqdn}'
output homeworkAgentName string = agentApp.name
output containerRegistryLoginServer string = registry.properties.loginServer

