// Asynchronous IMSCC import pipeline: a committed archive raises a blob event,
// Event Grid hands it to Service Bus for durable delivery, a Function claims the
// import and starts a Container Apps Job, and the job streams the archive from
// storage without it ever passing through the portal.

@description('Location for all resources')
param location string

@description('Short token used for resource naming')
param resourceToken string

@description('Tags applied to all resources')
param tags object

@description('Storage account holding the raw archives, processed batches, and import state table.')
param storageAccountName string

@description('Log Analytics workspace backing the Container Apps environment.')
param logAnalyticsWorkspaceName string

@description('Application Insights connection string for the dispatcher function.')
param applicationInsightsConnectionString string

param rawContainerName string
param processedContainerName string
param failedContainerName string
param importTableName string

@description('Container image for the extraction job. Empty deploys a public placeholder so the environment, and therefore the registry, can exist before the worker image has anywhere to be pushed.')
param extractionImage string = ''

@description('Name of an Event Grid system topic that already exists for the storage account. Only one system topic is allowed per account, and Defender for Storage creates one for malware scanning. Empty creates a new topic.')
param storageSystemTopicName string = ''

@description('CPU cores for the extraction job. Multi-gigabyte archives are IO bound, but unzip and text extraction are not free.')
param extractionCpu string = '2.0'

@description('Minutes an extraction may go without a heartbeat before the watchdog restarts it. Must exceed the archive download time for the largest expected export.')
@minValue(15)
param watchdogExtractingMinutes int = 60

@description('Minutes an import may sit in indexing before the watchdog fails it. Indexing is now owned by a stage that checkpoints as it goes, so a record that stops moving really is stuck.')
@minValue(0)
param watchdogIndexingMinutes int = 60

@description('Maximum imports a single watchdog run may act on, so one sweep cannot become a job storm.')
@minValue(1)
param watchdogSweepLimit int = 100

@description('Search service endpoint the indexer publishes verified course content to.')
param searchEndpoint string

@description('Search service that hosts the course content index.')
param searchServiceName string

@description('Foundry account that hosts the embedding deployment.')
param foundryAccountName string

@description('Search index that receives imported course documents.')
param searchIndexName string = 'course-content-index'

@description('Azure OpenAI endpoint used to embed course content.')
param openAiEndpoint string

@description('Embedding deployment name. Must match the vector dimensions configured on the index.')
param embeddingDeployment string

@description('Milliseconds an indexing invocation may run before it checkpoints and hands the rest to a continuation message. Must stay below the Function App timeout.')
@minValue(0)
param indexerBudgetMs int = 240000

@description('Memory for the extraction job. Must pair with the CPU value allowed by Container Apps.')
param extractionMemory string = '4Gi'

@description('Seconds an extraction replica may run before Container Apps stops it.')
param extractionTimeoutSeconds int = 3600

var queueName = 'imscc-imports'
var indexQueueName = 'imscc-indexing'
var extractionContainerName = 'extractor'
var serviceBusDataReceiverRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0')
var serviceBusDataSenderRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '69a216fc-b8fb-44d8-bc22-1f3c2cd27a39')
var containerAppsJobsOperatorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b9a307c4-5aa3-4b52-ba60-2b17c136cd7b')
var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var storageBlobDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var storageBlobDataOwnerRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
var storageQueueDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
var storageTableDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')

// Until the worker image is built and pushed there is nothing in the registry
// to run, so the job runs a public sample instead. This keeps provisioning and
// image publishing independent: the registry has to exist before an image can
// be pushed to it.
var placeholderImage = 'mcr.microsoft.com/k8se/quickstart-jobs:latest'
var usesOwnRegistry = !empty(extractionImage)
var jobImage = usesOwnRegistry ? extractionImage : placeholderImage
var searchIndexDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8ebe5a00-799e-43f5-93ac-243d3dce84a7')
var openAiUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')

resource search 'Microsoft.Search/searchServices@2024-06-01-preview' existing = {
  name: searchServiceName
}

resource foundry 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: foundryAccountName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

// --- Durable event delivery ----------------------------------------------
resource serviceBus 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: 'sb-${resourceToken}'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    disableLocalAuth: true
    minimumTlsVersion: '1.2'
  }
}

resource importQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: serviceBus
  name: queueName
  properties: {
    // Extraction can take minutes, so the lock is renewed by the host rather
    // than being held for the whole job.
    lockDuration: 'PT5M'
    maxDeliveryCount: 5
    deadLetteringOnMessageExpiration: true
    defaultMessageTimeToLive: 'P1D'
    enablePartitioning: false
  }
}

resource indexQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: serviceBus
  name: indexQueueName
  properties: {
    lockDuration: 'PT5M'
    maxDeliveryCount: 5
    deadLetteringOnMessageExpiration: true
    defaultMessageTimeToLive: 'P1D'
    enablePartitioning: false
  }
}

// Azure allows exactly one system topic per storage account. Defender for
// Storage creates one automatically for malware scanning, so a greenfield name
// cannot be assumed: pass the existing topic's name and the subscriptions below
// are added to it instead. Declaring it here rather than referencing it as
// 'existing' is deliberate, because the topic needs a system-assigned identity
// that Defender's topic does not have.
resource storageSystemTopic 'Microsoft.EventGrid/systemTopics@2023-12-15-preview' = {
  name: empty(storageSystemTopicName) ? 'evgt-${resourceToken}' : storageSystemTopicName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    source: storage.id
    topicType: 'Microsoft.Storage.StorageAccounts'
  }
}

resource eventGridServiceBusSend 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: serviceBus
  name: guid(serviceBus.id, storageSystemTopic.id, 'sb-send')
  properties: {
    principalId: storageSystemTopic.identity.principalId
    roleDefinitionId: serviceBusDataSenderRoleId
    principalType: 'ServicePrincipal'
  }
}

resource importEventSubscription 'Microsoft.EventGrid/systemTopics/eventSubscriptions@2023-12-15-preview' = {
  parent: storageSystemTopic
  name: 'imscc-uploaded'
  properties: {
    deliveryWithResourceIdentity: {
      identity: {
        type: 'SystemAssigned'
      }
      destination: {
        endpointType: 'ServiceBusQueue'
        properties: {
          resourceId: importQueue.id
        }
      }
    }
    filter: {
      // Only committed archives under a professor's raw prefix are of interest;
      // policy blobs and in-progress blocks must never reach the queue.
      includedEventTypes: [
        'Microsoft.Storage.BlobCreated'
      ]
      subjectBeginsWith: '/blobServices/default/containers/${rawContainerName}/blobs/'
      subjectEndsWith: '/course.imscc'
      advancedFilters: [
        {
          operatorType: 'StringIn'
          key: 'data.api'
          values: [
            'PutBlockList'
            'PutBlob'
            'CopyBlob'
          ]
        }
      ]
    }
    retryPolicy: {
      maxDeliveryAttempts: 10
      eventTimeToLiveInMinutes: 1440
    }
  }
  dependsOn: [
    eventGridServiceBusSend
  ]
}

// The completion manifest is the only signal that extraction finished, so it is
// what starts indexing. A batch blob arriving first must never trigger a
// partial index, which is why the filter is this narrow.
resource indexEventSubscription 'Microsoft.EventGrid/systemTopics/eventSubscriptions@2023-12-15-preview' = {
  parent: storageSystemTopic
  name: 'imscc-extracted'
  properties: {
    deliveryWithResourceIdentity: {
      identity: {
        type: 'SystemAssigned'
      }
      destination: {
        endpointType: 'ServiceBusQueue'
        properties: {
          resourceId: indexQueue.id
        }
      }
    }
    filter: {
      includedEventTypes: [
        'Microsoft.Storage.BlobCreated'
      ]
      subjectBeginsWith: '/blobServices/default/containers/${processedContainerName}/blobs/'
      subjectEndsWith: '/completion.json'
      advancedFilters: [
        {
          operatorType: 'StringIn'
          key: 'data.api'
          values: [
            'PutBlockList'
            'PutBlob'
            'CopyBlob'
          ]
        }
      ]
    }
    retryPolicy: {
      maxDeliveryAttempts: 10
      eventTimeToLiveInMinutes: 1440
    }
  }
  // Event Grid validates that this identity can reach the destination the moment
  // the subscription is created, and a role assignment ARM has just returned from
  // is not necessarily visible to that check yet. Creating both subscriptions at
  // once puts two validations in the same propagation window, and on a new
  // environment the second one loses: it fails with a managed identity
  // authorization error even though the assignment above is correct and is
  // already depended upon. Creating them in sequence keeps the second validation
  // behind the first success, which is the only ordering signal available here
  // short of adding a deployment script purely to sleep.
  dependsOn: [
    eventGridServiceBusSend
    importEventSubscription
  ]
}

// --- Extraction worker ----------------------------------------------------
resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: 'acr${uniqueString(resourceGroup().id)}'
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
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

// A user-assigned identity breaks the ordering problem that kept the registry
// out of the job definition. A system-assigned principal only exists once the
// job exists, so it cannot be granted pull rights before the job first starts.
// This identity is created, and granted them, ahead of the job.
resource extractionIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-job-imscc-${resourceToken}'
  location: location
  tags: tags
}

resource extractionJob 'Microsoft.App/jobs@2024-03-01' = {
  name: 'job-imscc-${resourceToken}'
  location: location
  tags: union(tags, {
    'azd-service-name': 'extraction-worker'
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${extractionIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironment.id
    configuration: {
      // The dispatcher starts one execution per import and overrides the
      // environment, so the job itself is never scheduled or triggered by load.
      triggerType: 'Manual'
      replicaTimeout: extractionTimeoutSeconds
      replicaRetryLimit: 1
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      // Declared unconditionally, including on the placeholder deployment, so
      // that `azd deploy` can push an image and swap it in without a second
      // provision. The identity already holds AcrPull by the time the job is
      // created, so an empty registry is not a problem.
      registries: [
        {
          server: registry.properties.loginServer
          identity: extractionIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: extractionContainerName
          image: jobImage
          resources: {
            cpu: json(extractionCpu)
            memory: extractionMemory
          }
          env: [
            {
              name: 'STORAGE_ACCOUNT'
              value: storageAccountName
            }
            {
              name: 'RAW_IMSCC_CONTAINER'
              value: rawContainerName
            }
            {
              name: 'PROCESSED_CONTAINER'
              value: processedContainerName
            }
            {
              name: 'FAILED_CONTAINER'
              value: failedContainerName
            }
            {
              name: 'IMSCC_IMPORT_TABLE'
              value: importTableName
            }
            // DefaultAzureCredential has no way to pick between identities, so
            // a user-assigned one has to be named explicitly.
            {
              name: 'AZURE_CLIENT_ID'
              value: extractionIdentity.properties.clientId
            }
          ]
        }
      ]
    }
  }
  // The job must not be created before its identity can pull from the registry,
  // or the first execution fails on an image pull it has no rights to make.
  dependsOn: [
    jobPullsImage
  ]
}

// --- Dispatcher function --------------------------------------------------
// The Functions host shares the course storage account rather than getting its
// own. Shared-key access is disabled tenant-wide, so the host has to use its
// managed identity, and a second account would be one more thing needing a
// public-network exemption for no benefit.

// The portal's Linux App Service plan lives in this same resource group, and a
// resource group cannot host Linux dynamic (Consumption) workers once it holds a
// non-dynamic Linux plan: 'Y1'/'Dynamic' fails preflight with
// LinuxDynamicWorkersNotAllowedInResourceGroup. Flex Consumption is a separate
// tier that does not use those dynamic workers, and it is what makes azd's
// 'remoteBuild' legal: azd refuses remoteBuild on every other plan type, so on a
// dedicated plan the dispatcher's dependencies have to be shipped in the zip.
resource functionPlan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: 'plan-fn-${resourceToken}'
  location: location
  tags: tags
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true
  }
}

// Flex Consumption keeps the deployment package in a blob container rather than
// in the site's file system, and builds from it remotely.
resource deploymentBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource functionDeploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: deploymentBlobService
  name: 'function-deployments'
  properties: {
    publicAccess: 'None'
  }
}

resource dispatcher 'Microsoft.Web/sites@2024-04-01' = {
  name: 'fn-imscc-${resourceToken}'
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: functionPlan.id
    httpsOnly: true
    // Flex Consumption declares the runtime and the deployment source here
    // instead of through linuxFxVersion and the FUNCTIONS_* app settings, and
    // it scales on demand, so alwaysOn no longer applies: the Service Bus and
    // timer triggers are driven by the platform's own scaler.
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${functionDeploymentContainer.name}'
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 40
        instanceMemoryMB: 2048
      }
      runtime: {
        name: 'node'
        version: '20'
      }
    }
    siteConfig: {
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        // Identity-based host storage. Shared-key access is disabled, so a
        // connection string built from listKeys() would never authenticate.
        {
          name: 'AzureWebJobsStorage__blobServiceUri'
          value: 'https://${storageAccountName}.blob.${environment().suffixes.storage}'
        }
        {
          name: 'AzureWebJobsStorage__queueServiceUri'
          value: 'https://${storageAccountName}.queue.${environment().suffixes.storage}'
        }
        {
          name: 'AzureWebJobsStorage__tableServiceUri'
          value: 'https://${storageAccountName}.table.${environment().suffixes.storage}'
        }
        {
          name: 'AzureWebJobsStorage__credential'
          value: 'managedidentity'
        }
        // FUNCTIONS_EXTENSION_VERSION, FUNCTIONS_WORKER_RUNTIME and
        // WEBSITE_NODE_DEFAULT_VERSION are rejected on Flex Consumption: the
        // runtime is declared in functionAppConfig.runtime instead.
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: applicationInsightsConnectionString
        }
        // Identity-based Service Bus access: no connection string is stored.
        {
          name: 'ServiceBusConnection__fullyQualifiedNamespace'
          value: '${serviceBus.name}.servicebus.windows.net'
        }
        {
          name: 'ServiceBusConnection__credential'
          value: 'managedidentity'
        }
        {
          name: 'IMPORT_QUEUE_NAME'
          value: queueName
        }
        {
          name: 'STORAGE_ACCOUNT'
          value: storageAccountName
        }
        {
          name: 'IMSCC_IMPORT_TABLE'
          value: importTableName
        }
        {
          name: 'RAW_IMSCC_CONTAINER'
          value: rawContainerName
        }
        {
          name: 'SUBSCRIPTION_ID'
          value: subscription().subscriptionId
        }
        {
          name: 'RESOURCE_GROUP'
          value: resourceGroup().name
        }
        {
          name: 'EXTRACTION_JOB_NAME'
          value: extractionJob.name
        }
        {
          name: 'EXTRACTION_JOB_IMAGE'
          value: jobImage
        }
        {
          // Restated to the job on every start, because the dispatcher's
          // container override replaces the job's own environment.
          name: 'EXTRACTION_IDENTITY_CLIENT_ID'
          value: extractionIdentity.properties.clientId
        }
        {
          name: 'EXTRACTION_CONTAINER_NAME'
          value: extractionContainerName
        }
        {
          name: 'WATCHDOG_EXTRACTING_MINUTES'
          value: string(watchdogExtractingMinutes)
        }
        {
          name: 'WATCHDOG_INDEXING_MINUTES'
          value: string(watchdogIndexingMinutes)
        }
        {
          name: 'WATCHDOG_SWEEP_LIMIT'
          value: string(watchdogSweepLimit)
        }
        {
          name: 'PROCESSED_CONTAINER'
          value: processedContainerName
        }
        {
          name: 'INDEX_QUEUE_NAME'
          value: indexQueueName
        }
        {
          name: 'SERVICE_BUS_NAMESPACE'
          value: serviceBus.name
        }
        {
          name: 'SEARCH_ENDPOINT'
          value: searchEndpoint
        }
        {
          name: 'SEARCH_INDEX_NAME'
          value: searchIndexName
        }
        {
          name: 'OPENAI_ENDPOINT'
          value: openAiEndpoint
        }
        {
          name: 'EMBEDDING_DEPLOYMENT'
          value: embeddingDeployment
        }
        {
          name: 'INDEXER_BUDGET_MS'
          value: string(indexerBudgetMs)
        }
      ]
    }
  }
}

// The dispatcher already reports to Application Insights, which is how the
// "0 functions found" startup failure was eventually traced. Routing the same
// logs to the workspace keeps host diagnostics alongside the extraction job's,
// so a stalled import can be followed across both without changing tools.
resource dispatcherDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: dispatcher
  name: 'send-to-log-analytics'
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      {
        category: 'FunctionAppLogs'
        enabled: true
      }
    ]
  }
}

// --- Least-privilege access ----------------------------------------------
resource dispatcherQueueReceive 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: serviceBus
  name: guid(serviceBus.id, dispatcher.id, 'sb-receive')
  properties: {
    principalId: dispatcher.identity.principalId
    roleDefinitionId: serviceBusDataReceiverRoleId
    principalType: 'ServicePrincipal'
  }
}

resource dispatcherStartsJob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: extractionJob
  name: guid(extractionJob.id, dispatcher.id, 'job-operator')
  properties: {
    principalId: dispatcher.identity.principalId
    roleDefinitionId: containerAppsJobsOperatorRoleId
    principalType: 'ServicePrincipal'
  }
}

resource jobPullsImage 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, extractionIdentity.id, 'acr-pull')
  properties: {
    principalId: extractionIdentity.properties.principalId
    roleDefinitionId: acrPullRoleId
    principalType: 'ServicePrincipal'
  }
}

module dispatcherTableRole './storage-role.bicep' = {
  name: 'dispatcher-table-role'
  params: {
    storageAccountName: storageAccountName
    principalId: dispatcher.identity.principalId
    roleDefinitionId: storageTableDataContributorRoleId
  }
}

// The indexer reads staged batches and writes embedded batches back, so the
// Function App needs blob access the dispatcher never required.
module dispatcherBlobRole './storage-role.bicep' = {
  name: 'dispatcher-blob-role'
  params: {
    storageAccountName: storageAccountName
    principalId: dispatcher.identity.principalId
    roleDefinitionId: storageBlobDataContributorRoleId
  }
}

// The Functions host stores its own singleton leases and host id in the same
// account, which needs owner-level blob access plus queues.
module dispatcherHostBlobRole './storage-role.bicep' = {
  name: 'dispatcher-host-blob-role'
  params: {
    storageAccountName: storageAccountName
    principalId: dispatcher.identity.principalId
    roleDefinitionId: storageBlobDataOwnerRoleId
  }
}

module dispatcherHostQueueRole './storage-role.bicep' = {
  name: 'dispatcher-host-queue-role'
  params: {
    storageAccountName: storageAccountName
    principalId: dispatcher.identity.principalId
    roleDefinitionId: storageQueueDataContributorRoleId
  }
}

// Indexing a large course outlives one invocation, so the app sends itself a
// continuation message.
resource dispatcherQueueSend 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: serviceBus
  name: guid(serviceBus.id, dispatcher.id, 'sb-send')
  properties: {
    principalId: dispatcher.identity.principalId
    roleDefinitionId: serviceBusDataSenderRoleId
    principalType: 'ServicePrincipal'
  }
}

resource indexerWritesSearch 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: search
  name: guid(search.id, dispatcher.id, 'search-index-contributor')
  properties: {
    principalId: dispatcher.identity.principalId
    roleDefinitionId: searchIndexDataContributorRoleId
    principalType: 'ServicePrincipal'
  }
}

resource indexerCallsEmbeddings 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundry
  name: guid(foundry.id, dispatcher.id, 'openai-user')
  properties: {
    principalId: dispatcher.identity.principalId
    roleDefinitionId: openAiUserRoleId
    principalType: 'ServicePrincipal'
  }
}

module jobBlobRole './storage-role.bicep' = {
  name: 'extraction-job-blob-role'
  params: {
    storageAccountName: storageAccountName
    principalId: extractionIdentity.properties.principalId
    roleDefinitionId: storageBlobDataContributorRoleId
  }
}

module jobTableRole './storage-role.bicep' = {
  name: 'extraction-job-table-role'
  params: {
    storageAccountName: storageAccountName
    principalId: extractionIdentity.properties.principalId
    roleDefinitionId: storageTableDataContributorRoleId
  }
}

output serviceBusNamespaceName string = serviceBus.name
output importQueueName string = queueName
output containerRegistryName string = registry.name
output containerRegistryLoginServer string = registry.properties.loginServer
output extractionJobName string = extractionJob.name
output extractionJobImage string = jobImage
output extractionContainerName string = extractionContainerName
output dispatcherFunctionName string = dispatcher.name
output indexQueueName string = indexQueueName
