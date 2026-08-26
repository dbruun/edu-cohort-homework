'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// The sweep's value is in acting on exactly the right records and surviving the
// ones it cannot fix, so the table and the job API are stubbed and every write
// is observed directly.
const state = { entities: new Map(), started: [], failStartFor: new Set(), failWriteFor: new Set() };

function stubModule(request, exports) {
  const filename = require.resolve(request);
  const stub = new Module(filename);
  stub.filename = filename;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[filename] = stub;
}

stubModule('@azure/identity', { DefaultAzureCredential: class {} });
stubModule('@azure/functions', { app: { timer: () => {}, serviceBusQueue: () => {} } });
stubModule('@azure/data-tables', {
  TableClient: class {
    listEntities(options) {
      const filter = options && options.queryOptions && options.queryOptions.filter;
      state.lastFilter = filter;
      const rows = [...state.entities.values()]
        .filter((entity) => !filter || filter.includes(`status eq '${entity.status}'`))
        .map((entity) => ({ ...entity }));
      return (async function* iterate() {
        for (const row of rows) yield row;
      })();
    }

    async updateEntity(patch) {
      if (state.failWriteFor.has(patch.rowKey)) throw new Error('Table rejected the write');
      const key = `${patch.partitionKey}|${patch.rowKey}`;
      state.entities.set(key, { ...state.entities.get(key), ...patch });
    }
  }
});
stubModule('../src/jobs', {
  extractionJobConfig: () => ({
    subscriptionId: 'sub',
    resourceGroup: 'rg',
    jobName: 'job',
    containerName: 'extractor',
    image: 'image:tag',
    storageAccount: 'stexample',
    rawContainer: 'raw-imscc',
    processedContainer: 'processed-course-content',
    failedContainer: 'failed-imports',
    importTable: 'ImsccImports'
  }),
  startExtractionJob: async (config, identified) => {
    if (state.failStartFor.has(identified.importId)) throw new Error('ARM rejected the request');
    state.started.push({ config, identified });
    return { started: true };
  }
});

process.env.STORAGE_ACCOUNT = 'testaccount';
process.env.SUBSCRIPTION_ID = 'sub-1';
process.env.RESOURCE_GROUP = 'rg-1';
process.env.EXTRACTION_JOB_NAME = 'job-extract';
process.env.EXTRACTION_JOB_IMAGE = 'acr.azurecr.io/extractor:1';

const { sweepStuckImports } = require('../src/functions/importWatchdog');

const partitionKey = 'a'.repeat(64);
const context = { log: () => {}, warn: () => {}, error: () => {} };

function ago(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function reset(entities = []) {
  state.entities.clear();
  state.started.length = 0;
  state.failStartFor.clear();
  state.failWriteFor.clear();
  delete process.env.WATCHDOG_SWEEP_LIMIT;
  for (const entity of entities) {
    state.entities.set(`${partitionKey}|${entity.rowKey}`, { partitionKey, ...entity });
  }
}

function stored(rowKey) {
  return state.entities.get(`${partitionKey}|${rowKey}`);
}

test('restarts a stalled extraction exactly once per sweep and records the attempt', async () => {
  reset([{ rowKey: 'stalled', status: 'extracting', createdAt: ago(200), updatedAt: ago(120) }]);

  const summary = await sweepStuckImports({}, context);

  assert.equal(summary.retried, 1);
  assert.equal(state.started.length, 1);
  assert.equal(state.started[0].identified.importId, 'stalled');
  assert.equal(state.started[0].identified.partitionKey, partitionKey);
  assert.equal(stored('stalled').status, 'queued');
  assert.equal(stored('stalled').extractionAttempts, 1);
});

test('a repeatedly stalled import is retried a bounded number of times, then failed', async () => {
  reset([{ rowKey: 'doomed', status: 'extracting', createdAt: ago(400), updatedAt: ago(300) }]);

  for (let sweep = 0; sweep < 3; sweep += 1) {
    state.entities.get(`${partitionKey}|doomed`).updatedAt = ago(300);
    delete state.entities.get(`${partitionKey}|doomed`).heartbeatAt;
    state.entities.get(`${partitionKey}|doomed`).status = 'extracting';
    await sweepStuckImports({}, context);
  }
  assert.equal(state.started.length, 3, 'the retry budget must be spent, not exceeded');

  state.entities.get(`${partitionKey}|doomed`).updatedAt = ago(300);
  state.entities.get(`${partitionKey}|doomed`).status = 'extracting';
  const summary = await sweepStuckImports({}, context);

  assert.equal(summary.retried, 0, 'a spent budget must not start another job');
  assert.equal(state.started.length, 3);
  assert.equal(stored('doomed').status, 'failed-processing');
});

test('leaves healthy and finished imports untouched', async () => {
  reset([
    { rowKey: 'fresh', status: 'extracting', createdAt: ago(5), updatedAt: ago(1) },
    { rowKey: 'beating', status: 'extracting', createdAt: ago(600), updatedAt: ago(600), heartbeatAt: ago(1) },
    { rowKey: 'done', status: 'complete', createdAt: ago(600), updatedAt: ago(600) },
    { rowKey: 'indexed', status: 'indexing', createdAt: ago(600), updatedAt: ago(600) }
  ]);

  const summary = await sweepStuckImports({}, context);

  assert.equal(state.started.length, 0);
  assert.equal(summary.retried + summary.failed, 0);
  assert.equal(stored('done').status, 'complete');
  assert.equal(stored('indexed').status, 'indexing', 'a successful extraction must survive the sweep');
});

test('reads only watched statuses from the table', async () => {
  reset([{ rowKey: 'fresh', status: 'uploaded', createdAt: ago(1), updatedAt: ago(1) }]);
  await sweepStuckImports({}, context);
  assert.ok(!state.lastFilter.includes("'complete'"), 'finished imports must not be paged through');
});

test('one unrecoverable import does not stop the others from being recovered', async () => {
  reset([
    { rowKey: 'broken', status: 'extracting', createdAt: ago(400), updatedAt: ago(300) },
    { rowKey: 'fixable', status: 'extracting', createdAt: ago(400), updatedAt: ago(300) }
  ]);
  state.failStartFor.add('broken');

  const summary = await sweepStuckImports({}, context);

  assert.equal(summary.errors, 1);
  assert.equal(summary.retried, 1);
  assert.deepEqual(state.started.map((call) => call.identified.importId), ['fixable']);
});

test('records the attempt before starting the job, so a crashed sweep cannot hand out free retries', async () => {
  reset([{ rowKey: 'broken', status: 'extracting', createdAt: ago(400), updatedAt: ago(300) }]);
  state.failStartFor.add('broken');

  await sweepStuckImports({}, context);

  assert.equal(stored('broken').extractionAttempts, 1, 'a failed start must still consume an attempt');
});

test('expires an abandoned upload with a message the professor can act on', async () => {
  reset([{ rowKey: 'abandoned', status: 'uploading', createdAt: ago(300), updatedAt: ago(300), expiresAt: ago(60) }]);

  const summary = await sweepStuckImports({}, context);

  assert.equal(summary.failed, 1);
  assert.equal(state.started.length, 0, 'an expired upload must never start a job');
  assert.equal(stored('abandoned').status, 'upload-expired');
  assert.match(stored('abandoned').error, /Start the import again/);
});

test('a single run cannot turn into an unbounded job storm', async () => {
  const many = Array.from({ length: 12 }, (unused, index) => ({
    rowKey: `stalled-${index}`,
    status: 'extracting',
    createdAt: ago(400),
    updatedAt: ago(300)
  }));
  reset(many);
  process.env.WATCHDOG_SWEEP_LIMIT = '5';

  const summary = await sweepStuckImports({}, context);

  assert.equal(summary.inspected, 5);
  assert.equal(state.started.length, 5, 'the sweep limit must bound the jobs a single run starts');
});
