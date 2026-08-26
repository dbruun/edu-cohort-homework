'use strict';

const assert = require('node:assert');
const test = require('node:test');

const { API_VERSION, extractionJobConfig, jobStartBody, jobStartUrl } = require('../src/jobs');

const config = {
  subscriptionId: 'sub-1',
  resourceGroup: 'rg-1',
  jobName: 'job-imscc',
  containerName: 'extractor',
  image: 'registry.azurecr.io/worker:abc123',
  storageAccount: 'stexample',
  rawContainer: 'raw-imscc',
  processedContainer: 'processed-course-content',
  failedContainer: 'failed-imports',
  importTable: 'ImsccImports',
  identityClientId: 'client-id-1'
};

test('starts the job with a template the ARM API accepts', () => {
  const body = jobStartBody(config, { importId: 'import-1', partitionKey: 'pk-1' });

  // The start API takes a JobExecutionTemplate directly. Nesting the containers
  // under a 'template' property is rejected with HTTP 400 and every import
  // dead-letters, so the shape of this payload is the contract under test.
  assert.deepEqual(Object.keys(body), ['containers']);
  assert.equal(body.template, undefined);
  assert.equal(body.containers.length, 1);
});

test('carries every variable the worker requires', () => {
  const body = jobStartBody(config, { importId: 'import-1', partitionKey: 'pk-1' });
  const supplied = new Map(body.containers[0].env.map((entry) => [entry.name, entry.value]));

  // A container override replaces the job's own environment rather than merging
  // into it. Omitting any of these leaves the worker exiting on a missing
  // variable, which surfaces only in the container log.
  for (const name of [
    'STORAGE_ACCOUNT',
    'RAW_IMSCC_CONTAINER',
    'PROCESSED_CONTAINER',
    'FAILED_CONTAINER',
    'IMSCC_IMPORT_TABLE',
    'IMPORT_ID',
    'IMPORT_PARTITION_KEY',
    'AZURE_CLIENT_ID'
  ]) {
    assert.ok(supplied.get(name), `${name} must be passed to the worker`);
  }

  assert.equal(supplied.get('STORAGE_ACCOUNT'), 'stexample');
  assert.equal(supplied.get('IMPORT_ID'), 'import-1');
  assert.equal(supplied.get('IMPORT_PARTITION_KEY'), 'pk-1');
  // The worker authenticates as the job's user-assigned identity, which
  // DefaultAzureCredential can only select when named explicitly.
  assert.equal(supplied.get('AZURE_CLIENT_ID'), 'client-id-1');
});

test('reads the job configuration from the environment', () => {
  const resolved = extractionJobConfig({
    SUBSCRIPTION_ID: 'sub-1',
    RESOURCE_GROUP: 'rg-1',
    EXTRACTION_JOB_NAME: 'job-imscc',
    EXTRACTION_JOB_IMAGE: 'registry.azurecr.io/worker:abc123',
    EXTRACTION_IDENTITY_CLIENT_ID: 'client-id-1',
    STORAGE_ACCOUNT: 'stexample'
  });

  assert.equal(resolved.storageAccount, 'stexample');
  assert.equal(resolved.containerName, 'extractor');
  assert.equal(resolved.failedContainer, 'failed-imports');
  assert.equal(resolved.identityClientId, 'client-id-1');
});

test('refuses to start without a storage account', () => {
  assert.throws(
    () => extractionJobConfig({
      SUBSCRIPTION_ID: 'sub-1',
      RESOURCE_GROUP: 'rg-1',
      EXTRACTION_JOB_NAME: 'job-imscc',
      EXTRACTION_JOB_IMAGE: 'registry.azurecr.io/worker:abc123',
      EXTRACTION_IDENTITY_CLIENT_ID: 'client-id-1'
    }),
    /STORAGE_ACCOUNT is required/
  );
});

test('tells the worker which import to process', () => {
  const body = jobStartBody(config, { importId: 'import-1', partitionKey: 'pk-1' });
  const [container] = body.containers;

  assert.equal(container.name, config.containerName);
  assert.equal(container.image, config.image);
});

test('targets the job start endpoint', () => {
  const url = jobStartUrl(config);

  assert.equal(
    url,
    'https://management.azure.com/subscriptions/sub-1/resourceGroups/rg-1' +
      `/providers/Microsoft.App/jobs/job-imscc/start?api-version=${API_VERSION}`
  );
});
