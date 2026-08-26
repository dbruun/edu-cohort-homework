'use strict';

// Indexing is the stage that can least afford to be restarted from scratch: it
// costs embedding tokens. Every decision about what to index next, and what to
// trust in a batch, is made here so it can be tested without Search, without
// the embedding model, and without Azure.

const MANIFEST_NAME = 'completion.json';
// Only an import whose extraction finished may be indexed. Anything else is a
// replay, a cancellation, or work that already completed.
const INDEXABLE_STATUSES = new Set(['indexing']);
const BLOB_CREATED = 'Microsoft.Storage.BlobCreated';
const COMMIT_APIS = new Set(['PutBlockList', 'PutBlob', 'CopyBlob', 'FlushWithClose']);
const IMPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BATCH_NAME_PATTERN = /^batch-\d{5}\.ndjson$/;
// courseName is required because it is now part of the embedded text: a batch
// without it would produce vectors that silently lose the course signal. The
// worker already refuses to extract a package whose manifest has no title, so
// this asserts a guarantee that already holds rather than adding a new one.
const REQUIRED_DOCUMENT_FIELDS = ['id', 'professorId', 'importId', 'courseName', 'content'];

function canIndex(entity) {
  return INDEXABLE_STATUSES.has(entity && entity.status);
}

function eventType(event) {
  return (event && (event.eventType || event.type)) || '';
}

function blobPathFromSubject(subject, container) {
  const marker = `/containers/${container}/blobs/`;
  const index = typeof subject === 'string' ? subject.indexOf(marker) : -1;
  return index === -1 ? '' : subject.slice(index + marker.length);
}

function blobPathFromUrl(url, container) {
  if (typeof url !== 'string') return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  const prefix = `/${container}/`;
  return parsed.pathname.startsWith(prefix) ? decodeURIComponent(parsed.pathname.slice(prefix.length)) : '';
}

// A continuation the indexer sent itself is trusted differently from a blob
// event, but both must resolve to an import id the same way.
function importFromIndexMessage(message, { container = 'processed-course-content' } = {}) {
  if (!message || typeof message !== 'object') return { error: 'the message is not an object' };

  if (message.kind === 'indexing-continuation') {
    return IMPORT_ID_PATTERN.test(message.importId || '') && typeof message.partitionKey === 'string' && message.partitionKey
      ? { importId: message.importId, partitionKey: message.partitionKey, continuation: true }
      : { error: 'the continuation does not name a valid import' };
  }

  if (eventType(message) !== BLOB_CREATED) return { error: `unrelated event type '${eventType(message)}'` };
  const data = message.data || {};
  if (data.api && !COMMIT_APIS.has(data.api)) return { error: `the manifest is not committed yet (${data.api})` };

  const blobName = blobPathFromSubject(message.subject, container) || blobPathFromUrl(data.url, container);
  if (!blobName) return { error: 'the event does not name a blob in the processed container' };

  const segments = blobName.split('/');
  // Only the completion manifest starts indexing. A batch blob arriving first
  // must never trigger a partial index.
  if (segments.length !== 2 || segments[1] !== MANIFEST_NAME) return { error: `unexpected blob path '${blobName}'` };
  if (!IMPORT_ID_PATTERN.test(segments[0])) return { error: 'the blob path has no valid import id' };

  return { importId: segments[0], continuation: false };
}

function manifestError(message) {
  return Object.assign(new Error(message), { validation: true });
}

// The manifest is written by the worker, but it is read after a trust boundary
// and drives how many embedding calls are made, so it is validated rather than
// assumed.
function validateManifest(manifest, expected = {}) {
  if (!manifest || typeof manifest !== 'object') throw manifestError('The completion manifest is not an object.');
  if (expected.importId && manifest.importId !== expected.importId) {
    throw manifestError('The completion manifest belongs to a different import.');
  }
  if (!Array.isArray(manifest.batches) || !manifest.batches.length) {
    throw manifestError('The completion manifest lists no document batches.');
  }
  for (const name of manifest.batches) {
    // A batch name becomes a blob path, so it may never be able to escape the
    // import's own prefix.
    if (typeof name !== 'string' || !BATCH_NAME_PATTERN.test(name)) {
      throw manifestError(`The completion manifest names an unexpected batch '${name}'.`);
    }
  }
  if (new Set(manifest.batches).size !== manifest.batches.length) {
    throw manifestError('The completion manifest names the same batch more than once.');
  }
  return manifest.batches;
}

function checkpointOf(entity, field) {
  const value = Number(entity && entity[field]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// Work always resumes at the first batch that has not been checkpointed, so a
// restart re-embeds nothing that already succeeded.
function remainingBatches(batches, checkpoint) {
  return batches.slice(Math.min(Math.max(checkpoint, 0), batches.length));
}

function parseBatch(ndjson, expected = {}) {
  const documents = [];
  const lines = String(ndjson).split('\n');
  for (const [position, line] of lines.entries()) {
    if (!line.trim()) continue;
    let document;
    try {
      document = JSON.parse(line);
    } catch {
      throw manifestError(`Batch line ${position + 1} is not valid JSON.`);
    }
    for (const field of REQUIRED_DOCUMENT_FIELDS) {
      if (typeof document[field] !== 'string' || !document[field]) {
        throw manifestError(`Batch line ${position + 1} is missing '${field}'.`);
      }
    }
    // A document that names a different import or professor would index one
    // professor's content into another's results, so it is refused outright.
    if (expected.importId && document.importId !== expected.importId) {
      throw manifestError(`Batch line ${position + 1} belongs to a different import.`);
    }
    if (expected.professorId && document.professorId !== expected.professorId) {
      throw manifestError(`Batch line ${position + 1} belongs to a different professor.`);
    }
    documents.push(document);
  }
  if (!documents.length) throw manifestError('A document batch contains no documents.');
  return documents;
}

function groupsOf(items, size) {
  if (!Number.isInteger(size) || size < 1) throw new Error('size must be a positive integer.');
  const groups = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

// The embedded text must match what a professor would search for, and must not
// silently become 'undefined' when a document has no title. The course name is
// included because a question is usually asked about a course ("what does my
// Biology 101 syllabus say"), and a chunk pulled out of the middle of a file
// otherwise carries nothing that identifies which course it came from. This
// improves how well a course-scoped question retrieves; it is not an isolation
// boundary, because retrieval still runs across every professor's content.
function embeddingInput(document) {
  return [document.courseName, document.title, document.content].filter(Boolean).join('\n\n');
}

// Search has no transaction across documents, so the guarantee that students
// never see a half-indexed course comes from ordering, not from a flag:
// embedding is staged to blob storage first, and nothing is written to Search
// until every batch of the import has been embedded and verified.
function vectorBatchName(batchName) {
  return batchName.replace(/^batch-/, 'vectors-');
}

// The embedded batch is staged exactly as it will be uploaded, so the upload
// phase costs no model calls and can be retried freely.
function stagedActions(documents, vectors) {
  if (documents.length !== vectors.length) {
    throw new Error('Every document must have exactly one embedding before it is staged.');
  }
  return documents.map((document, position) => ({
    '@search.action': 'mergeOrUpload',
    ...document,
    // A document only ever reaches the index after the whole import passed, so
    // being present and being active are the same thing.
    isActive: true,
    contentVector: vectors[position]
  }));
}

function serializeActions(actions) {
  return `${actions.map((action) => JSON.stringify(action)).join('\n')}\n`;
}

function parseStagedActions(ndjson) {
  const actions = [];
  for (const [position, line] of String(ndjson).split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      actions.push(JSON.parse(line));
    } catch {
      throw manifestError(`Staged batch line ${position + 1} is not valid JSON.`);
    }
  }
  if (!actions.length) throw manifestError('A staged batch contains no documents.');
  return actions;
}

module.exports = {
  BATCH_NAME_PATTERN,
  INDEXABLE_STATUSES,
  MANIFEST_NAME,
  REQUIRED_DOCUMENT_FIELDS,
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
};
