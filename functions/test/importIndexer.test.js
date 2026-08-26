'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// The guarantee worth testing is an ordering one: nothing reaches Search until
// the whole import has been embedded. Storage, Service Bus, the model, and
// Search are stubbed so that ordering can be observed directly.
const state = {
  entities: new Map(),
  blobs: new Map(),
  uploaded: [],
  embedded: [],
  continuations: [],
  failUploadFor: new Set()
};

function stubModule(request, exports) {
  const filename = require.resolve(request);
  const stub = new Module(filename);
  stub.filename = filename;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[filename] = stub;
}

stubModule('@azure/identity', { DefaultAzureCredential: class {} });
stubModule('@azure/functions', { app: { serviceBusQueue: () => {}, timer: () => {} } });
stubModule('@azure/data-tables', {
  TableClient: class {
    listEntities(options) {
      const filter = options && options.queryOptions && options.queryOptions.filter;
      const match = /RowKey eq '([^']*)'/.exec(filter || '');
      const rows = [...state.entities.values()].filter((entity) => !match || entity.rowKey === match[1]);
      return (async function* iterate() {
        for (const row of rows) yield { ...row };
      })();
    }

    async updateEntity(patch) {
      const key = `${patch.partitionKey}|${patch.rowKey}`;
      state.entities.set(key, { ...state.entities.get(key), ...patch });
    }
  }
});
stubModule('@azure/storage-blob', {
  BlobServiceClient: class {
    getContainerClient() {
      return {
        getBlockBlobClient(name) {
          return {
            async downloadToBuffer() {
              if (!state.blobs.has(name)) throw Object.assign(new Error(`Missing blob ${name}`), { statusCode: 404 });
              return Buffer.from(state.blobs.get(name), 'utf8');
            },
            async upload(body) {
              state.blobs.set(name, String(body));
            }
          };
        }
      };
    }
  }
});
stubModule('@azure/service-bus', {
  ServiceBusClient: class {
    createSender() {
      return {
        async sendMessages(message) { state.continuations.push(message.body); },
        async close() {}
      };
    }

    async close() {}
  }
});
stubModule('../src/search', {
  DEFAULT_EMBEDDING_GROUP: 16,
  DEFAULT_UPLOAD_GROUP: 100,
  async embedTexts(texts) {
    state.embedded.push(...texts);
    return texts.map((text, index) => [text.length, index]);
  },
  async uploadActions(actions) {
    for (const action of actions) {
      if (state.failUploadFor.has(action.id)) throw new Error('Search rejected the document');
    }
    state.uploaded.push(...actions);
    return actions.length;
  }
});

process.env.STORAGE_ACCOUNT = 'testaccount';
process.env.SERVICE_BUS_NAMESPACE = 'sb-test';

const { indexImport } = require('../src/functions/importIndexer');

const importId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const partitionKey = 'a'.repeat(64);
const context = { log: () => {}, warn: () => {}, error: () => {} };

const event = {
  eventType: 'Microsoft.Storage.BlobCreated',
  subject: `/blobServices/default/containers/processed-course-content/blobs/${importId}/completion.json`,
  data: { api: 'PutBlockList' }
};

function document(index) {
  return {
    id: `doc-${index}`,
    professorId: 'prof-a',
    importId,
    courseName: 'Biology 101',
    title: `Title ${index}`,
    content: `Content ${index}`
  };
}

function reset({ batchCount = 2, entity = {}, manifest = {} } = {}) {
  state.entities.clear();
  state.blobs.clear();
  state.uploaded.length = 0;
  state.embedded.length = 0;
  state.continuations.length = 0;
  state.failUploadFor.clear();
  delete process.env.INDEXER_BUDGET_MS;

  const batches = Array.from({ length: batchCount }, (unused, index) => `batch-${String(index + 1).padStart(5, '0')}.ndjson`);
  batches.forEach((name, index) => {
    state.blobs.set(`${importId}/${name}`, `${JSON.stringify(document(index))}\n`);
  });
  state.blobs.set(`${importId}/completion.json`, JSON.stringify({
    importId,
    chunksProduced: batchCount,
    batches,
    ...manifest
  }));
  state.entities.set(`${partitionKey}|${importId}`, {
    partitionKey,
    rowKey: importId,
    professorId: 'prof-a',
    status: 'indexing',
    ...entity
  });
  return batches;
}

function stored() {
  return state.entities.get(`${partitionKey}|${importId}`);
}

test('publishes an import only after every batch has been embedded', async () => {
  reset({ batchCount: 3 });

  const result = await indexImport(event, context);

  assert.equal(result.completed, true);
  assert.equal(state.uploaded.length, 3);
  assert.equal(stored().status, 'complete');
  assert.equal(stored().embeddedBatches, 3);
  assert.equal(stored().uploadedBatches, 3);
  // The course a chunk belongs to has to reach the model, or a course-scoped
  // question cannot retrieve a passage from the middle of a file.
  assert.ok(
    state.embedded.every((text) => text.includes('Biology 101')),
    'every embedded text must carry its course name'
  );
});

test('writes nothing to Search when the work is suspended part way through embedding', async () => {
  reset({ batchCount: 3 });
  // Zero budget suspends at the first batch boundary, which is exactly the
  // window in which nothing may have reached Search yet.
  process.env.INDEXER_BUDGET_MS = '0';

  const result = await indexImport(event, context);

  assert.equal(result.suspended, true);
  assert.equal(state.uploaded.length, 0, 'a partially embedded import must never be visible to students');
  assert.equal(stored().status, 'indexing');
  assert.equal(stored().embeddedBatches, 1);
  assert.deepEqual(state.continuations, [{ kind: 'indexing-continuation', importId, partitionKey }]);
});

test('a continuation resumes without paying for the same embeddings twice', async () => {
  reset({ batchCount: 3, entity: { embeddedBatches: 2 } });
  state.blobs.set(`${importId}/vectors-00001.ndjson`, `${JSON.stringify({ id: 'doc-0' })}\n`);
  state.blobs.set(`${importId}/vectors-00002.ndjson`, `${JSON.stringify({ id: 'doc-1' })}\n`);

  await indexImport({ kind: 'indexing-continuation', importId, partitionKey }, context);

  assert.equal(state.embedded.length, 1, 'only the batch that was never embedded may be embedded again');
  assert.equal(state.uploaded.length, 3, 'every batch is still published');
  assert.equal(stored().status, 'complete');
});

// The Service Bus binding reports only "Failed" and a duration, so without an
// explicit log the dead-lettered message is the only evidence of the cause.
test('logs the reason and the import id before letting the failure dead-letter', async () => {
  reset({ batchCount: 2 });
  state.failUploadFor.add('doc-1');
  const errors = [];
  const recording = { log: () => {}, warn: () => {}, error: (line) => errors.push(line) };

  await assert.rejects(indexImport(event, recording), /Search rejected the document/);

  assert.equal(errors.length, 1, 'the failure is reported exactly once');
  assert.match(errors[0], /Search rejected the document/, 'the reason has to survive');
  assert.match(errors[0], new RegExp(importId), 'the log has to identify which import failed');
});

test('an upload that fails leaves the import resumable rather than complete', async () => {
  reset({ batchCount: 2 });
  state.failUploadFor.add('doc-1');

  await assert.rejects(indexImport(event, context), /Search rejected the document/);

  assert.equal(stored().status, 'indexing', 'a failed publish must not report completion');
  assert.equal(stored().uploadedBatches, 1, 'the checkpoint must record what actually succeeded');
});

// The portal's processing bar reads documentsIndexed of documentsDiscovered.
// The count is written under that exact name, and while indexing is still in
// progress, or the bar has nothing to show.
test('reports the indexed document count under the name the portal reads', async () => {
  reset({ batchCount: 3 });

  await indexImport(event, context);

  assert.equal(stored().documentsIndexed, 3);
});

test('advances the indexed document count before the import completes', async () => {
  const batches = reset({ batchCount: 3, entity: { embeddedBatches: 3 } });
  batches.forEach((name, index) => {
    state.blobs.set(`${importId}/${name.replace(/^batch-/, 'vectors-')}`, `${JSON.stringify(document(index))}\n`);
  });
  // Every batch is already embedded, so a zero budget suspends inside the
  // upload phase: exactly when a professor is watching the bar move.
  process.env.INDEXER_BUDGET_MS = '0';

  const result = await indexImport(event, context);

  assert.equal(result.suspended, true);
  assert.equal(stored().status, 'indexing');
  assert.equal(stored().documentsIndexed, 1, 'progress must be visible while indexing is still running');
});

test('a resumed upload keeps counting rather than restarting the total', async () => {
  const batches = reset({ batchCount: 3, entity: { embeddedBatches: 3, uploadedBatches: 1, documentsIndexed: 1 } });
  batches.forEach((name, index) => {
    state.blobs.set(`${importId}/${name.replace(/^batch-/, 'vectors-')}`, `${JSON.stringify(document(index))}\n`);
  });

  await indexImport({ kind: 'indexing-continuation', importId, partitionKey }, context);

  assert.equal(stored().documentsIndexed, 3, 'the count must include what an earlier invocation published');
});

test('refuses a batch containing another professor\'s document', async () => {  reset({ batchCount: 1 });
  state.blobs.set(`${importId}/batch-00001.ndjson`, `${JSON.stringify({ ...document(0), professorId: 'prof-b' })}\n`);

  await assert.rejects(indexImport(event, context), /different professor/);
  assert.equal(state.uploaded.length, 0);
});

test('refuses a manifest that points at another import', async () => {
  reset({ batchCount: 1, manifest: { importId: '00000000-0000-4000-8000-000000000000' } });

  await assert.rejects(indexImport(event, context), /different import/);
  assert.equal(state.embedded.length, 0);
});

test('indexes nothing for an import that was cancelled', async () => {
  reset({ batchCount: 2, entity: { cancellationRequested: true } });

  const result = await indexImport(event, context);

  assert.equal(result.cancelled, true);
  assert.equal(state.uploaded.length, 0);
  assert.equal(stored().status, 'cancelled');
});

test('ignores an import that is not waiting to be indexed', async () => {
  for (const status of ['uploading', 'uploaded', 'queued', 'extracting', 'complete', 'failed-validation']) {
    reset({ batchCount: 1, entity: { status } });
    const result = await indexImport(event, context);
    assert.equal(result.skipped, true, `'${status}' must not be indexed`);
    assert.equal(state.uploaded.length, 0);
  }
});

test('ignores a message with no matching import record', async () => {
  reset({ batchCount: 1 });
  state.entities.clear();

  const result = await indexImport(event, context);

  assert.equal(result.skipped, true);
  assert.equal(state.embedded.length, 0);
});

test('ignores a batch blob event, which arrives before extraction has finished', async () => {
  reset({ batchCount: 1 });

  const result = await indexImport({
    ...event,
    subject: `/blobServices/default/containers/processed-course-content/blobs/${importId}/batch-00001.ndjson`
  }, context);

  assert.equal(result.skipped, true);
  assert.equal(state.uploaded.length, 0);
});
