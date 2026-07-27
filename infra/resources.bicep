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

@secure()
@description('Encryption key used by the ltijs LTI tool for cookies/state')
param ltiEncryptionKey string

@secure()
@description('Admin password for the self-hosted MongoDB used by the LTI tool')
param mongoAdminPassword string

var agentServiceName = 'homework-agent'
var ltiServiceName = 'lti-tool'
var mongoServiceName = 'mongo'
var mongoAdminUsername = 'ltiadmin'

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

// --- ltijs LTI 1.3 tool (thin) -------------------------------------------
// ltijs requires a MongoDB store. Managed Cosmos DB for MongoDB is blocked by
// governance policy in this tenant (public network access AND local/key auth
// are both disabled by management-group `modify` policies), so we self-host
// Mongo as an internal-only Container App on the same environment. Nothing is
// exposed publicly; the LTI app reaches it over private in-environment TCP.
// NOTE: storage is ephemeral — Mongo data (incl. LTI platform registrations) is
// lost if the replica is recycled. Use a managed Mongo for production.
// Mongo runs as a sidecar in the LTI app (same pod) so the tool reaches it over
// localhost — ACA's Envoy TCP ingress does not reliably proxy the Mongo wire
// protocol between apps, so a separate Mongo Container App fails SDAM handshake.
resource ltiApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${ltiServiceName}-${resourceToken}'
  location: location
  tags: union(tags, {
    'azd-service-name': ltiServiceName
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
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          name: 'lti-key'
          value: ltiEncryptionKey
        }
        {
          name: 'mongo-password'
          value: mongoAdminPassword
        }
        {
          name: 'mongo-url'
          value: 'mongodb://${mongoAdminUsername}:${mongoAdminPassword}@localhost:27017/ltijs?authSource=admin'
        }
      ]
    }
    template: {
      containers: [
        {
          name: ltiServiceName
          image: 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: [
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'LTI_KEY'
              secretRef: 'lti-key'
            }
            {
              name: 'MONGO_URL'
              secretRef: 'mongo-url'
            }
            {
              name: 'FRAME_ANCESTORS'
              value: '*.instructure.com *.blackboard.com'
            }
            {
              name: 'TOOL_URL'
              value: 'https://ca-${ltiServiceName}-${resourceToken}.${managedEnv.properties.defaultDomain}'
            }
            {
              name: 'HOMEWORK_AGENT_URL'
              value: 'https://${agentApp.properties.configuration.ingress.fqdn}'
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsights.properties.ConnectionString
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
          ]
        }
        {
          name: mongoServiceName
          image: 'mongo:7'
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: [
            {
              name: 'MONGO_INITDB_ROOT_USERNAME'
              value: mongoAdminUsername
            }
            {
              name: 'MONGO_INITDB_ROOT_PASSWORD'
              secretRef: 'mongo-password'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output homeworkAgentUrl string = 'https://${agentApp.properties.configuration.ingress.fqdn}'
output homeworkAgentName string = agentApp.name
output ltiToolUrl string = 'https://${ltiApp.properties.configuration.ingress.fqdn}'
output ltiToolName string = ltiApp.name
output containerRegistryLoginServer string = registry.properties.loginServer
