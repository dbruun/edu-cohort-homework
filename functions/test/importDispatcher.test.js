'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// The handler's value is in what it refuses to dispatch, so the table and the
// job API are stubbed and every decision is observed directly.
const state = { entities: new Map(), started: [], failNextStart: false };

function stubModule(request, exports) {
  const filename = require.resolve(request);
  const stub = new Module(filename);
  stub.filename = filename;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[filename] = stub;
}

stubModule('@azure/identity', { DefaultAzureCredential: class {} });
stubModule('@azure/functions', { app: { serviceBusQueue: () => {} } });
stubModule('@azure/data-tables', {
  TableClient: class {
    async getEntity(partitionKey, rowKey) {
      const entity = state.entities.get(`${partitionKey}|${rowKey}`);
      if (!entity) throw Object.assign(new Error('Not found'), { statusCode: 404 });
      return { ...entity };
    }

    async updateEntity(patch) {
      const key = `${patch.partitionKey}|${patch.rowKey}`;
      state.entities.set(key, { ...state.entities.get(key), ...patch });
    }
  }
});
stubModule('../src/jobs', {
  extractionJobConfig: () => ({
    subscriptionId: 'sub',
    resourceGroup: 'rg',
    jobName: 'job-extract',
    containerName: 'extractor',
    image: 'image:tag',
    storageAccount: 'stexample',
    rawContainer: 'raw-imscc',
    processedContainer: 'processed-course-content',
    failedContainer: 'failed-imports',
    importTable: 'ImsccImports'
  }),
  startExtractionJob: async (config, identified) => {
    if (state.failNextStart) {
      state.failNextStart = false;
      throw new Error('ARM rejected the request');
    }
    state.started.push({ config, identified });
    return { started: true };
  }
});

process.env.STORAGE_ACCOUNT = 'testaccount';
process.env.SUBSCRIPTION_ID = 'sub-1';
process.env.RESOURCE_GROUP = 'rg-1';
process.env.EXTRACTION_JOB_NAME = 'job-extract';
process.env.EXTRACTION_JOB_IMAGE = 'acr.azurecr.io/extractor:1';

const { dispatchImport } = require('../src/functions/importDispatcher');

const partitionKey = 'a'.repeat(64);
const importId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const blobName = `${partitionKey}/${importId}/course.imscc`;
const event = {
  eventType: 'Microsoft.Storage.BlobCreated',
  subject: `/blobServices/default/containers/raw-imscc/blobs/${blobName}`,
  data: { api: 'PutBlockList', contentLength: 4096 }
};
const context = { log: () => {}, warn: () => {} };

function seed(entity) {
  state.entities.clear();
  state.started.length = 0;
  state.entities.set(`${partitionKey}|${importId}`, { partitionKey, rowKey: importId, ...entity });
}

function stored() {
  return state.entities.get(`${partitionKey}|${importId}`);
}

test('claims the import and starts one extraction job', async () => {
  seed({ status: 'uploaded' });
  await dispatchImport(JSON.stringify(event), context);

  assert.equal(state.started.length, 1);
  assert.deepEqual(state.started[0].identified.importId, importId);
  assert.equal(state.started[0].config.jobName, 'job-extract');
  assert.equal(stored().status, 'queued');
  assert.equal(stored().uploadedBytes, 4096);
});

test('does not start a second job for a duplicate event', async () => {
  seed({ status: 'uploaded' });
  await dispatchImport(event, context);
  await dispatchImport(event, context);
  await dispatchImport(event, context);

  assert.equal(state.started.length, 1, 'a replayed blob event must not reprocess the import');
});

test('starts no job for an import that moved on or was cancelled', async () => {
  for (const status of ['queued', 'extracting', 'indexing', 'complete', 'failed-validation', 'cancelled']) {
    seed({ status });
    await dispatchImport(event, context);
    assert.equal(state.started.length, 0, `status '${status}' must not start a job`);
  }

  seed({ status: 'uploaded', cancellationRequested: true });
  await dispatchImport(event, context);
  assert.equal(state.started.length, 0, 'a cancelled import must not start a job');
});

test('ignores an event with no matching import record', async () => {
  state.entities.clear();
  state.started.length = 0;
  await dispatchImport(event, context);
  assert.equal(state.started.length, 0);
});

test('releases the claim when the job cannot be started, so the retry can take it', async () => {
  seed({ status: 'uploaded' });
  state.failNextStart = true;

  await assert.rejects(dispatchImport(event, context), /ARM rejected the request/);
  assert.equal(stored().status, 'uploaded', 'a failed start must not strand the import in queued');

  await dispatchImport(event, context);
  assert.equal(state.started.length, 1);
});

test('ignores an unrelated message without failing the queue delivery', async () => {
  seed({ status: 'uploaded' });
  await dispatchImport(JSON.stringify({ eventType: 'Microsoft.Storage.BlobDeleted', subject: '' }), context);
  assert.equal(state.started.length, 0);
  assert.equal(stored().status, 'uploaded');
});
