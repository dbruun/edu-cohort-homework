'use strict';

const { DefaultAzureCredential } = require('@azure/identity');

const ARM_SCOPE = 'https://management.azure.com/.default';
const API_VERSION = '2024-03-01';

let cachedCredential;
function credential() {
  if (!cachedCredential) cachedCredential = new DefaultAzureCredential();
  return cachedCredential;
}

function jobStartUrl({ subscriptionId, resourceGroup, jobName }) {
  return `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.App/jobs/${jobName}/start?api-version=${API_VERSION}`;
}

// Starting a job with a container override replaces the container definition
// rather than merging into it, so the job's own environment is lost. Every
// variable the worker needs has to be restated here.
function workerEnvironment(config, { importId, partitionKey }) {
  return [
    { name: 'STORAGE_ACCOUNT', value: config.storageAccount },
    { name: 'RAW_IMSCC_CONTAINER', value: config.rawContainer },
    { name: 'PROCESSED_CONTAINER', value: config.processedContainer },
    { name: 'FAILED_CONTAINER', value: config.failedContainer },
    { name: 'IMSCC_IMPORT_TABLE', value: config.importTable },
    { name: 'IMPORT_ID', value: importId },
    { name: 'IMPORT_PARTITION_KEY', value: partitionKey },
    // The job runs under a user-assigned identity, which DefaultAzureCredential
    // cannot pick out on its own. Losing this leaves the worker unable to get a
    // token at all, failing on "Unable to load the proper Managed Identity".
    { name: 'AZURE_CLIENT_ID', value: config.identityClientId }
  ];
}

// The start API takes a JobExecutionTemplate directly: wrapping it in a
// 'template' property is rejected with HTTP 400.
function jobStartBody(config, identified) {
  return {
    containers: [
      {
        name: config.containerName,
        image: config.image,
        env: workerEnvironment(config, identified)
      }
    ]
  };
}

// Both callers have to supply the worker's whole environment, so the shape of
// this config lives with the job code rather than being restated per caller.
function extractionJobConfig(environment = process.env) {
  const require_ = (name) => {
    const value = environment[name];
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };

  return {
    subscriptionId: require_('SUBSCRIPTION_ID'),
    resourceGroup: require_('RESOURCE_GROUP'),
    jobName: require_('EXTRACTION_JOB_NAME'),
    containerName: environment.EXTRACTION_CONTAINER_NAME || 'extractor',
    image: require_('EXTRACTION_JOB_IMAGE'),
    identityClientId: require_('EXTRACTION_IDENTITY_CLIENT_ID'),
    storageAccount: require_('STORAGE_ACCOUNT'),
    rawContainer: environment.RAW_IMSCC_CONTAINER || 'raw-imscc',
    processedContainer: environment.PROCESSED_CONTAINER || 'processed-course-content',
    failedContainer: environment.FAILED_CONTAINER || 'failed-imports',
    importTable: environment.IMSCC_IMPORT_TABLE || 'ImsccImports'
  };
}

async function startExtractionJob(config, { importId, partitionKey }) {
  const token = await credential().getToken(ARM_SCOPE);
  const response = await fetch(jobStartUrl(config), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(jobStartBody(config, { importId, partitionKey }))
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // Throwing returns the message to the queue, so a throttled or transient
    // ARM failure is retried and eventually dead-lettered rather than lost.
    throw new Error(`Starting the extraction job failed with HTTP ${response.status}. ${detail}`.trim());
  }
  return { started: true, status: response.status };
}

module.exports = { API_VERSION, ARM_SCOPE, extractionJobConfig, jobStartBody, jobStartUrl, startExtractionJob, workerEnvironment };
