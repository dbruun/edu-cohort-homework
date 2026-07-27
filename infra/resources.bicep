@description('Location for all resources')
param location string

@description('Short token used for resource naming')
param resourceToken string

@description('Tags applied to all resources')
param tags object

@description('MCP endpoint for the Foundry Toolbox')
param toolboxEndpoint string = ''

@description('Model deployment the agent invokes')
param modelDeploymentName string = 'gpt-5.4'

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

// --- Foundry (Azure AI Services) account + project + gpt-4o model ----------
// Basic Foundry setup: an AIServices account hosts a project and a model
// deployment the MAF agent calls via AIProjectClient. No capability host /
// Cosmos / Search needed — the agent only performs model inference.
resource foundry 'Microsoft.CognitiveServices/accounts@2026-05-15-preview' = {
  name: 'aif-${resourceToken}'
  location: location
  tags: tags
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: 'aif-${resourceToken}'
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: false
  }
}

resource foundryProject 'Microsoft.CognitiveServices/accounts/projects@2026-05-15-preview' = {
  parent: foundry
  name: 'homework'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    displayName: 'Homework Tutor'
    description: 'EDU homework tutor project.'
  }
}

resource chatModelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: foundry
  name: 'gpt-5.4'
  sku: {
    name: 'GlobalStandard'
    capacity: 50
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-5.4'
      version: '2026-03-05'
    }
  }
}

// The agent's managed identity needs to call models on the Foundry account.
var cognitiveServicesUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a97b65f3-24c7-4388-baec-2e87135dc908')
resource foundryAgentRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, identity.id, cognitiveServicesUserRoleId)
  scope: foundry
  properties: {
    principalId: identity.properties.principalId
    roleDefinitionId: cognitiveServicesUserRoleId
    principalType: 'ServicePrincipal'
  }
}

// Foundry project data-plane endpoint consumed by AIProjectClient in the agent.
var foundryProjectEndpointUrl = 'https://${foundry.name}.services.ai.azure.com/api/projects/${foundryProject.name}'

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
              value: foundryProjectEndpointUrl
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
output foundryAccountName string = foundry.name
output foundryProjectEndpoint string = foundryProjectEndpointUrl
output containerRegistryLoginServer string = registry.properties.loginServer
