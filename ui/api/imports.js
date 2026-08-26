const crypto = require('crypto');
const { TableClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');
const {
  BlobSASPermissions,
  BlobServiceClient,
  SASProtocol,
  generateBlobSASQueryParameters
} = require('@azure/storage-blob');

const DEFAULT_SAS_MINUTES = 240;
const IMPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A professor returning to the portal needs to see work that is still running,
// not an empty page. These bound what that costs: Table Storage orders rows by
// RowKey, and a RowKey is the import id, so recency has to come from a scan and
// a sort rather than from the store. The window keeps that scan small, and the
// scan cap keeps a professor with a very large history from being expensive.
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MAX_LIST_SCAN = 500;
const LIST_WINDOW_DAYS = 30;

// An import that reached one of these states will never do more work, so a
// cancellation request cannot change its outcome.
const TERMINAL_STATUSES = new Set([
  'complete',
  'cancelled',
  'failed-validation',
  'failed-processing',
  'failed-indexing',
  'upload-expired'
]);

// Before extraction starts nothing downstream owns the import, so the portal
// can cancel it outright instead of asking the pipeline to stop.
const DIRECTLY_CANCELLABLE_STATUSES = new Set(['uploading', 'uploaded', 'queued']);

function rawContainerName() {
  return process.env.RAW_IMSCC_CONTAINER || 'raw-imscc';
}

function storageAccountName() {
  const accountName = process.env.POLICY_STORAGE_ACCOUNT;
  if (!accountName) {
    throw Object.assign(new Error('IMSCC upload storage is not configured.'), { httpStatus: 503 });
  }
  return accountName;
}

function professorPartitionKey(professorId) {
  return crypto.createHash('sha256').update(professorId).digest('hex');
}

function validateCreateImport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('Import request must be an object.'), { httpStatus: 400 });
  }
  if (typeof value.originalFileName !== 'string' ||
    !value.originalFileName.trim().toLowerCase().endsWith('.imscc') ||
    value.originalFileName.length > 255) {
    throw Object.assign(
      new Error('Choose an IMSCC file with a filename no longer than 255 characters.'),
      { httpStatus: 400 }
    );
  }
  if (!Number.isSafeInteger(value.fileSize) || value.fileSize <= 0) {
    throw Object.assign(new Error('IMSCC file size must be a positive integer.'), { httpStatus: 400 });
  }
  return {
    originalFileName: value.originalFileName.trim(),
    fileSize: value.fileSize
  };
}

function createClients() {
  const accountName = storageAccountName();
  const credential = new DefaultAzureCredential();
  const blobService = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential
  );
  const table = new TableClient(
    `https://${accountName}.table.core.windows.net`,
    process.env.IMSCC_IMPORT_TABLE || 'ImsccImports',
    credential
  );
  return { accountName, blobService, table };
}

async function createImport(professor, request) {
  const input = validateCreateImport(request);
  const importId = crypto.randomUUID();
  const partitionKey = professorPartitionKey(professor.id);
  const blobName = `${partitionKey}/${importId}/course.imscc`;
  const containerName = rawContainerName();
  const now = new Date();
  const sasMinutes = Number(process.env.IMSCC_UPLOAD_SAS_MINUTES || DEFAULT_SAS_MINUTES);
  if (!Number.isInteger(sasMinutes) || sasMinutes < 15 || sasMinutes > 1440) {
    throw new Error('IMSCC_UPLOAD_SAS_MINUTES must be an integer from 15 to 1440.');
  }

  const { accountName, blobService, table } = createClients();
  const startsOn = new Date(now.getTime() - 5 * 60 * 1000);
  const expiresOn = new Date(now.getTime() + sasMinutes * 60 * 1000);
  let entityCreated = false;
  try {
    await table.createEntity({
      partitionKey,
      rowKey: importId,
      professorId: professor.id,
      professorName: professor.name,
      originalFileName: input.originalFileName,
      expectedBytes: input.fileSize,
      blobName,
      status: 'uploading',
      // The upload SAS cannot be renewed, so the watchdog needs to know when
      // the browser's window closes in order to retire an abandoned upload.
      expiresAt: expiresOn,
      createdAt: now,
      updatedAt: now
    });
    entityCreated = true;

    const delegationKey = await blobService.getUserDelegationKey(startsOn, expiresOn);
    const sas = generateBlobSASQueryParameters({
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse('cw'),
      protocol: SASProtocol.Https,
      startsOn,
      expiresOn
    }, delegationKey, accountName);
    const blob = blobService.getContainerClient(containerName).getBlockBlobClient(blobName);
    return {
      importId,
      status: 'uploading',
      uploadUrl: `${blob.url}?${sas}`,
      expiresAt: expiresOn.toISOString()
    };
  } catch (error) {
    console.error(`[imscc-import] Failed to create upload session ${importId}.`, error);
    if (entityCreated) {
      await table.deleteEntity(partitionKey, importId).catch((cleanupError) => {
        console.error(`[imscc-import] Failed to remove import ${importId} after SAS creation failed.`, cleanupError);
      });
    }
    throw Object.assign(new Error('The upload session could not be created. Try again.'), { httpStatus: 503 });
  }
}

function publicImport(entity) {
  return {
    importId: entity.rowKey,
    status: entity.status,
    originalFileName: entity.originalFileName,
    expectedBytes: Number(entity.expectedBytes),
    uploadedBytes: entity.uploadedBytes === undefined ? 0 : Number(entity.uploadedBytes),
    courseName: entity.courseName,
    courseNameSource: entity.courseNameSource,
    documentsDiscovered: entity.documentsDiscovered === undefined ? 0 : Number(entity.documentsDiscovered),
    documentsIndexed: entity.documentsIndexed === undefined ? 0 : Number(entity.documentsIndexed),
    cancellationRequested: entity.cancellationRequested === true,
    error: entity.error,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt
  };
}

async function loadEntity(table, partitionKey, importId) {
  if (!IMPORT_ID_PATTERN.test(importId)) throw Object.assign(new Error('Import was not found.'), { httpStatus: 404 });
  try {
    return await table.getEntity(partitionKey, importId);
  } catch (error) {
    if (error.statusCode === 404) throw Object.assign(new Error('Import was not found.'), { httpStatus: 404 });
    console.error(`[imscc-import] Failed to read import ${importId}.`, error);
    throw Object.assign(new Error('Import status is temporarily unavailable.'), { httpStatus: 503 });
  }
}

async function readImport(professor, importId) {
  const partitionKey = professorPartitionKey(professor.id);
  const { blobService, table } = createClients();
  let entity = await loadEntity(table, partitionKey, importId);

  try {
    if (entity.status === 'uploading') {
      const blob = blobService.getContainerClient(rawContainerName()).getBlockBlobClient(entity.blobName);
      if (await blob.exists()) {
        entity = {
          ...entity,
          status: 'uploaded',
          uploadedBytes: (await blob.getProperties()).contentLength,
          updatedAt: new Date()
        };
        await table.updateEntity(entity, 'Replace');
      }
    }
  } catch (error) {
    console.error(`[imscc-import] Failed to refresh blob state for import ${importId}.`, error);
    throw Object.assign(new Error('Import status is temporarily unavailable.'), { httpStatus: 503 });
  }

  return publicImport(entity);
}

// Cancellation is only advisory once a downstream stage owns the import: the
// worker checks the flag at its next checkpoint.
function nextCancelState(entity, now) {
  if (TERMINAL_STATUSES.has(entity.status)) {
    throw Object.assign(
      new Error('This import has already finished and can no longer be cancelled.'),
      { httpStatus: 409 }
    );
  }
  if (DIRECTLY_CANCELLABLE_STATUSES.has(entity.status)) {
    return { ...entity, status: 'cancelled', cancellationRequested: true, updatedAt: now };
  }
  return { ...entity, cancellationRequested: true, updatedAt: now };
}

async function cancelImport(professor, importId) {
  const partitionKey = professorPartitionKey(professor.id);
  const { blobService, table } = createClients();
  const entity = await loadEntity(table, partitionKey, importId);
  const cancelled = nextCancelState(entity, new Date());

  try {
    await table.updateEntity(cancelled, 'Replace');
  } catch (error) {
    console.error(`[imscc-import] Failed to cancel import ${importId}.`, error);
    throw Object.assign(new Error('The import could not be cancelled. Try again.'), { httpStatus: 503 });
  }

  // The archive is unusable once the import is cancelled, but a leftover blob
  // only wastes storage until the lifecycle policy removes it.
  if (cancelled.status === 'cancelled') {
    await blobService
      .getContainerClient(rawContainerName())
      .getBlockBlobClient(cancelled.blobName)
      .deleteIfExists()
      .catch((error) => {
        console.error(`[imscc-import] Failed to delete the archive for cancelled import ${importId}.`, error);
      });
  }

  return publicImport(cancelled);
}

// Newest first, by the time the professor started the import. createdAt is the
// stable ordering key: updatedAt moves as the pipeline works, so ordering by it
// would reshuffle the list under the professor while they are reading it.
function sortRecentFirst(records) {
  return [...records].sort((left, right) => {
    const leftTime = new Date(left.createdAt).getTime() || 0;
    const rightTime = new Date(right.createdAt).getTime() || 0;
    if (leftTime !== rightTime) return rightTime - leftTime;
    // Equal timestamps still need a deterministic order, or the list can
    // reorder between polls for no visible reason.
    return String(right.importId).localeCompare(String(left.importId));
  });
}

function listLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIST_LIMIT;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw Object.assign(new Error('limit must be a positive integer.'), { httpStatus: 400 });
  }
  return Math.min(limit, MAX_LIST_LIMIT);
}

async function listImports(professor, options = {}) {
  const limit = listLimit(options.limit);
  const partitionKey = professorPartitionKey(professor.id);
  const { table } = createClients();
  const since = new Date(Date.now() - LIST_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const collected = [];
  try {
    // The partition key is a hex digest of the professor id, so it cannot carry
    // a quote that would alter this filter.
    const entities = table.listEntities({
      queryOptions: { filter: `PartitionKey eq '${partitionKey}' and createdAt ge datetime'${since.toISOString()}'` }
    });
    for await (const entity of entities) {
      collected.push(entity);
      if (collected.length >= MAX_LIST_SCAN) break;
    }
  } catch (error) {
    console.error(`[imscc-import] Failed to list imports for ${professor.id}.`, error);
    throw Object.assign(new Error('Import history is temporarily unavailable.'), { httpStatus: 503 });
  }

  return sortRecentFirst(collected.map(publicImport)).slice(0, limit);
}

module.exports = {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_SCAN,
  cancelImport,
  createImport,
  listImports,
  listLimit,
  nextCancelState,
  professorPartitionKey,
  publicImport,
  readImport,
  sortRecentFirst,
  validateCreateImport
};
