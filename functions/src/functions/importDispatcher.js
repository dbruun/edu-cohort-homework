'use strict';

const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');
const { importFromEvent } = require('../dispatch');
const { extractionJobConfig, startExtractionJob } = require('../jobs');

// Extraction may only start from a state that is genuinely waiting for it, so a
// duplicate or replayed blob event cannot start a second job.
const DISPATCHABLE_STATUSES = new Set(['uploading', 'uploaded']);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

let cachedTable;
function importTable() {
  if (!cachedTable) {
    cachedTable = new TableClient(
      `https://${required('STORAGE_ACCOUNT')}.table.core.windows.net`,
      process.env.IMSCC_IMPORT_TABLE || 'ImsccImports',
      new DefaultAzureCredential()
    );
  }
  return cachedTable;
}

async function dispatchImport(message, context) {
  const event = typeof message === 'string' ? JSON.parse(message) : message;
  const identified = importFromEvent(event, { container: process.env.RAW_IMSCC_CONTAINER || 'raw-imscc' });

  // An event this pipeline cannot act on is complete, not failed: retrying it
  // would only dead-letter a message nothing will ever process.
  if (identified.error) {
    context.warn(`[dispatch] Ignoring event: ${identified.error}.`);
    return;
  }

  const table = importTable();
  let entity;
  try {
    entity = await table.getEntity(identified.partitionKey, identified.importId);
  } catch (error) {
    if (error.statusCode === 404) {
      context.warn(`[dispatch] Import ${identified.importId} has no record; ignoring the event.`);
      return;
    }
    throw error;
  }

  if (entity.cancellationRequested === true || entity.status === 'cancelled') {
    context.log(`[dispatch] Import ${identified.importId} was cancelled; no job started.`);
    return;
  }
  if (!DISPATCHABLE_STATUSES.has(entity.status)) {
    context.log(`[dispatch] Import ${identified.importId} is already '${entity.status}'; no job started.`);
    return;
  }

  // Claiming the import before starting the job means a duplicate event that
  // arrives while the job is starting sees 'queued' and stops.
  await table.updateEntity({
    partitionKey: identified.partitionKey,
    rowKey: identified.importId,
    status: 'queued',
    uploadedBytes: identified.contentLength || entity.uploadedBytes,
    updatedAt: new Date()
  }, 'Merge');

  try {
    await startExtractionJob(extractionJobConfig(), identified);
    context.log(`[dispatch] Started extraction for import ${identified.importId}.`);
  } catch (error) {
    // Hand the import back so the retried message can claim it again.
    await table.updateEntity({
      partitionKey: identified.partitionKey,
      rowKey: identified.importId,
      status: 'uploaded',
      updatedAt: new Date()
    }, 'Merge').catch(() => {});
    throw error;
  }
}

app.serviceBusQueue('dispatchImport', {
  queueName: process.env.IMPORT_QUEUE_NAME || 'imscc-imports',
  connection: 'ServiceBusConnection',
  handler: dispatchImport
});

module.exports = { DISPATCHABLE_STATUSES, dispatchImport };
