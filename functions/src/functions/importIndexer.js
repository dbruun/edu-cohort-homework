'use strict';

const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');
const { BlobServiceClient } = require('@azure/storage-blob');
const { ServiceBusClient } = require('@azure/service-bus');
const { DefaultAzureCredential } = require('@azure/identity');
const {
  MANIFEST_NAME,
  canIndex,
  checkpointOf,
  embeddingInput,
  groupsOf,
  importFromIndexMessage,
  parseBatch,
  parseStagedActions,
  remainingBatches,
  serializeActions,
  stagedActions,
  validateManifest,
  vectorBatchName
} = require('../indexing');
const { DEFAULT_EMBEDDING_GROUP, DEFAULT_UPLOAD_GROUP, embedTexts, uploadActions } = require('../search');

// A Consumption plan invocation is bounded, and a large course can outlast it.
// Rather than risk a mid-batch kill, the indexer stops at a batch boundary and
// hands the rest to a continuation message.
const DEFAULT_BUDGET_MS = 240000;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

let cachedCredential;
function credential() {
  if (!cachedCredential) cachedCredential = new DefaultAzureCredential();
  return cachedCredential;
}

let cachedTable;
function importTable() {
  if (!cachedTable) {
    cachedTable = new TableClient(
      `https://${required('STORAGE_ACCOUNT')}.table.core.windows.net`,
      process.env.IMSCC_IMPORT_TABLE || 'ImsccImports',
      credential()
    );
  }
  return cachedTable;
}

let cachedContainer;
function processedContainer() {
  if (!cachedContainer) {
    cachedContainer = new BlobServiceClient(
      `https://${required('STORAGE_ACCOUNT')}.blob.core.windows.net`,
      credential()
    ).getContainerClient(process.env.PROCESSED_CONTAINER || 'processed-course-content');
  }
  return cachedContainer;
}

async function readBlobText(name) {
  const buffer = await processedContainer().getBlockBlobClient(name).downloadToBuffer();
  return buffer.toString('utf8');
}

async function writeBlobText(name, body, contentType) {
  await processedContainer().getBlockBlobClient(name).upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: { blobContentType: contentType }
  });
}

// The completion manifest is addressed by import id alone, so the partition has
// to be recovered from the record rather than from the blob path.
async function findEntity(importId) {
  const rows = importTable().listEntities({ queryOptions: { filter: `RowKey eq '${importId}'` } });
  for await (const row of rows) return row;
  return null;
}

async function sendContinuation(importId, partitionKey) {
  const client = new ServiceBusClient(
    `${required('SERVICE_BUS_NAMESPACE')}.servicebus.windows.net`,
    credential()
  );
  try {
    const sender = client.createSender(process.env.INDEX_QUEUE_NAME || 'imscc-indexing');
    await sender.sendMessages({ body: { kind: 'indexing-continuation', importId, partitionKey } });
    await sender.close();
  } finally {
    await client.close();
  }
}

function budgetMs() {
  const budget = Number(process.env.INDEXER_BUDGET_MS);
  // Zero is a legitimate setting that suspends after every batch, so it is
  // honoured rather than treated as unset.
  return Number.isFinite(budget) && budget >= 0 ? budget : DEFAULT_BUDGET_MS;
}

function groupSize(name, fallback) {
  const size = Number(process.env[name]);
  return Number.isInteger(size) && size > 0 ? size : fallback;
}

async function embedBatch(entity, batchName, context) {
  const documents = parseBatch(await readBlobText(`${entity.rowKey}/${batchName}`), {
    importId: entity.rowKey,
    professorId: entity.professorId
  });

  const vectors = [];
  for (const group of groupsOf(documents, groupSize('EMBEDDING_GROUP_SIZE', DEFAULT_EMBEDDING_GROUP))) {
    vectors.push(...await embedTexts(group.map(embeddingInput)));
  }

  await writeBlobText(
    `${entity.rowKey}/${vectorBatchName(batchName)}`,
    serializeActions(stagedActions(documents, vectors)),
    'application/x-ndjson'
  );
  context.log(`[index] Embedded ${documents.length} document(s) of ${batchName} for import ${entity.rowKey}.`);
  return documents.length;
}

async function uploadBatch(entity, batchName, context) {
  const actions = parseStagedActions(await readBlobText(`${entity.rowKey}/${vectorBatchName(batchName)}`));
  for (const group of groupsOf(actions, groupSize('UPLOAD_GROUP_SIZE', DEFAULT_UPLOAD_GROUP))) {
    await uploadActions(group);
  }
  context.log(`[index] Uploaded ${actions.length} document(s) of ${batchName} for import ${entity.rowKey}.`);
  return actions.length;
}

async function runIndexImport(message, context) {
  const body = typeof message === 'string' ? JSON.parse(message) : message;
  const identified = importFromIndexMessage(body, { container: process.env.PROCESSED_CONTAINER || 'processed-course-content' });
  if (identified.error) {
    context.warn(`[index] Ignoring message: ${identified.error}.`);
    return { skipped: true };
  }

  const entity = await findEntity(identified.importId);
  if (!entity) {
    context.warn(`[index] Import ${identified.importId} has no record; ignoring the message.`);
    return { skipped: true };
  }
  if (entity.cancellationRequested === true || entity.status === 'cancelled') {
    await importTable().updateEntity({
      partitionKey: entity.partitionKey,
      rowKey: entity.rowKey,
      status: 'cancelled',
      updatedAt: new Date()
    }, 'Merge');
    context.log(`[index] Import ${entity.rowKey} was cancelled; nothing was indexed.`);
    return { cancelled: true };
  }
  if (!canIndex(entity)) {
    context.log(`[index] Import ${entity.rowKey} is '${entity.status}' and does not need indexing.`);
    return { skipped: true };
  }

  const manifest = JSON.parse(await readBlobText(`${entity.rowKey}/${MANIFEST_NAME}`));
  const batches = validateManifest(manifest, { importId: entity.rowKey });
  const deadline = Date.now() + budgetMs();
  const progress = {
    embedded: checkpointOf(entity, 'embeddedBatches'),
    uploaded: checkpointOf(entity, 'uploadedBatches'),
    // Resumed from the record so a continuation keeps counting from where the
    // previous invocation stopped rather than restarting the reported total.
    indexed: checkpointOf(entity, 'documentsIndexed')
  };

  const checkpoint = (patch) => importTable().updateEntity({
    partitionKey: entity.partitionKey,
    rowKey: entity.rowKey,
    updatedAt: new Date(),
    ...patch
  }, 'Merge');

  const suspend = async () => {
    await sendContinuation(entity.rowKey, entity.partitionKey);
    context.log(`[index] Import ${entity.rowKey} paused at ${progress.embedded}/${batches.length} embedded, ${progress.uploaded}/${batches.length} uploaded.`);
    return { suspended: true, ...progress };
  };

  // Phase one embeds every batch into blob storage. Nothing reaches Search
  // here, so an import that dies part way through is invisible rather than
  // half-published.
  for (const batchName of remainingBatches(batches, progress.embedded)) {
    await embedBatch(entity, batchName, context);
    progress.embedded += 1;
    await checkpoint({ embeddedBatches: progress.embedded });
    if (Date.now() >= deadline) return suspend();
  }

  // Phase two publishes the verified import. It costs no model calls, so a
  // retry is cheap and repeating an upload is harmless.
  for (const batchName of remainingBatches(batches, progress.uploaded)) {
    progress.indexed += await uploadBatch(entity, batchName, context);
    progress.uploaded += 1;
    await checkpoint({ uploadedBatches: progress.uploaded, documentsIndexed: progress.indexed });
    if (progress.uploaded < batches.length && Date.now() >= deadline) return suspend();
  }

  // documentsIndexed is not repeated here: the upload loop is its only writer,
  // and every batch has been checkpointed by the time completion is recorded.
  await checkpoint({
    status: 'complete',
    completedAt: new Date(),
    error: ''
  });
  context.log(`[index] Import ${entity.rowKey} is complete with ${batches.length} batch(es).`);
  return { completed: true, batches: batches.length };
}

// The throw has to reach the Service Bus binding for the message to be retried
// and eventually dead-lettered, so the error is re-raised unchanged. What the
// binding does not do is record why: the host writes only "Failed" and a
// duration, which makes a missing search index, a rejected embedding and a
// storage permission problem indistinguishable, with the sole remaining
// evidence a message sitting in the dead-letter queue. A missing index really
// did take five identical failures and a manual comparison of configured
// against existing index names to identify.
async function indexImport(message, context) {
  try {
    return await runIndexImport(message, context);
  } catch (error) {
    let importId = 'unknown';
    try {
      const body = typeof message === 'string' ? JSON.parse(message) : message;
      const identified = importFromIndexMessage(body, {
        container: process.env.PROCESSED_CONTAINER || 'processed-course-content'
      });
      if (identified.importId) importId = identified.importId;
    } catch {
      // The identifier is only here to make the log searchable. A message that
      // cannot be parsed is already reported by the failure being logged.
    }
    context.error(`[index] Import ${importId} failed: ${error.message}`);
    throw error;
  }
}

app.serviceBusQueue('indexImport', {
  queueName: process.env.INDEX_QUEUE_NAME || 'imscc-indexing',
  connection: 'ServiceBusConnection',
  handler: indexImport
});

module.exports = { DEFAULT_BUDGET_MS, indexImport };
