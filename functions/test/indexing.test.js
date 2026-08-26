'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../src/indexing');

const importId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function blobEvent(blobName, api = 'PutBlockList') {
  return {
    eventType: 'Microsoft.Storage.BlobCreated',
    subject: `/blobServices/default/containers/processed-course-content/blobs/${blobName}`,
    data: { api }
  };
}

test('only the completion manifest starts indexing', () => {
  const started = importFromIndexMessage(blobEvent(`${importId}/completion.json`));
  assert.equal(started.importId, importId);
  assert.equal(started.continuation, false);

  // A batch blob is written before the manifest, so reacting to one would index
  // an import that is still being extracted.
  assert.ok(importFromIndexMessage(blobEvent(`${importId}/batch-00001.ndjson`)).error);
  assert.ok(importFromIndexMessage(blobEvent(`${importId}/nested/completion.json`)).error);
  assert.ok(importFromIndexMessage(blobEvent('not-a-uuid/completion.json')).error);
});

test('ignores a manifest blob that is not committed yet', () => {
  assert.ok(importFromIndexMessage(blobEvent(`${importId}/completion.json`, 'PutBlock')).error);
});

test('ignores unrelated events and messages', () => {
  assert.ok(importFromIndexMessage({ eventType: 'Microsoft.Storage.BlobDeleted', subject: '' }).error);
  assert.ok(importFromIndexMessage('a string').error);
  assert.ok(importFromIndexMessage(null).error);
});

test('accepts a continuation it sent itself, but only a well-formed one', () => {
  const resumed = importFromIndexMessage({ kind: 'indexing-continuation', importId, partitionKey: 'a'.repeat(64) });
  assert.equal(resumed.importId, importId);
  assert.equal(resumed.continuation, true);

  assert.ok(importFromIndexMessage({ kind: 'indexing-continuation', importId }).error);
  assert.ok(importFromIndexMessage({ kind: 'indexing-continuation', importId: 'nope', partitionKey: 'x' }).error);
});

test('only indexes an import whose extraction finished', () => {
  assert.equal(canIndex({ status: 'indexing' }), true);
  for (const status of ['uploading', 'uploaded', 'queued', 'extracting', 'complete', 'cancelled', 'failed-validation']) {
    assert.equal(canIndex({ status }), false, `'${status}' must not be indexed`);
  }
});

test('refuses a manifest that would drive the wrong work', () => {
  assert.deepEqual(validateManifest({ importId, batches: ['batch-00001.ndjson'] }, { importId }), ['batch-00001.ndjson']);

  assert.throws(() => validateManifest({ importId: 'other', batches: ['batch-00001.ndjson'] }, { importId }), /different import/);
  assert.throws(() => validateManifest({ importId, batches: [] }, { importId }), /no document batches/);
  assert.throws(() => validateManifest({ importId }, { importId }), /no document batches/);
  // A batch name becomes a blob path; anything that could climb out of the
  // import's prefix must be refused rather than sanitized.
  assert.throws(() => validateManifest({ importId, batches: ['../../secrets.ndjson'] }, { importId }), /unexpected batch/);
  assert.throws(() => validateManifest({ importId, batches: ['batch-1.ndjson'] }, { importId }), /unexpected batch/);
  assert.throws(
    () => validateManifest({ importId, batches: ['batch-00001.ndjson', 'batch-00001.ndjson'] }, { importId }),
    /more than once/
  );
});

test('refuses documents belonging to another import or professor', () => {
  const mine = { id: 'doc-1', professorId: 'prof-a', importId, courseName: 'Biology 101', content: 'text' };
  const ndjson = (document) => `${JSON.stringify(document)}\n`;

  assert.equal(parseBatch(ndjson(mine), { importId, professorId: 'prof-a' }).length, 1);
  assert.throws(
    () => parseBatch(ndjson({ ...mine, importId: 'other' }), { importId, professorId: 'prof-a' }),
    /different import/
  );
  assert.throws(
    () => parseBatch(ndjson({ ...mine, professorId: 'prof-b' }), { importId, professorId: 'prof-a' }),
    /different professor/
  );
});

test('refuses a malformed or empty batch instead of indexing part of it', () => {
  assert.throws(() => parseBatch('{"id":"a"'), /not valid JSON/);
  assert.throws(
    () => parseBatch('{"id":"a","professorId":"p","importId":"i","courseName":"Biology 101"}\n'),
    /missing 'content'/
  );
  // The course name carries into the embedding, so a batch without it would
  // quietly produce vectors that cannot answer a course-scoped question.
  assert.throws(
    () => parseBatch('{"id":"a","professorId":"p","importId":"i","content":"text"}\n'),
    /missing 'courseName'/
  );
  assert.throws(() => parseBatch('   \n\n'), /no documents/);
});

test('resumes at the first batch that was never checkpointed', () => {
  const batches = ['batch-00001.ndjson', 'batch-00002.ndjson', 'batch-00003.ndjson'];
  assert.deepEqual(remainingBatches(batches, 0), batches);
  assert.deepEqual(remainingBatches(batches, 2), ['batch-00003.ndjson']);
  assert.deepEqual(remainingBatches(batches, 3), []);
  // A checkpoint that outran the manifest must not wrap around and redo work.
  assert.deepEqual(remainingBatches(batches, 9), []);
  assert.deepEqual(remainingBatches(batches, -1), batches);
});

test('reads a checkpoint conservatively', () => {
  assert.equal(checkpointOf({ embeddedBatches: 3 }, 'embeddedBatches'), 3);
  assert.equal(checkpointOf({}, 'embeddedBatches'), 0);
  assert.equal(checkpointOf({ embeddedBatches: 'many' }, 'embeddedBatches'), 0);
  assert.equal(checkpointOf({ embeddedBatches: -4 }, 'embeddedBatches'), 0);
});

test('groups inputs without losing or duplicating any', () => {
  assert.deepEqual(groupsOf([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(groupsOf([], 3), []);
  assert.throws(() => groupsOf([1], 0), /positive integer/);
});

test('embeds the text a professor would actually search for', () => {
  assert.equal(
    embeddingInput({ courseName: 'Biology 101', title: 'Cells', content: 'Mitochondria' }),
    'Biology 101\n\nCells\n\nMitochondria'
  );
  // A chunk has to carry its course, or a course-scoped question cannot match a
  // passage taken from the middle of a file.
  assert.match(embeddingInput({ courseName: 'Biology 101', content: 'Mitochondria' }), /Biology 101/);
  // Absent fields must not become the string 'undefined' inside the vector.
  assert.equal(embeddingInput({ content: 'Mitochondria' }), 'Mitochondria');
  assert.equal(embeddingInput({ courseName: 'Biology 101', content: 'Mitochondria' }), 'Biology 101\n\nMitochondria');
});

test('stages documents exactly as they will be uploaded', () => {
  const documents = [{ id: 'doc-1', professorId: 'p', importId, courseName: 'Biology 101', content: 'text' }];
  const [action] = stagedActions(documents, [[0.1, 0.2]]);

  assert.equal(action['@search.action'], 'mergeOrUpload');
  assert.deepEqual(action.contentVector, [0.1, 0.2]);
  // Upload happens only after the whole import is verified, so a document that
  // reaches the index is active by definition.
  assert.equal(action.isActive, true);

  assert.throws(() => stagedActions(documents, []), /exactly one embedding/);
});

test('a staged batch survives the round trip through blob storage', () => {
  const documents = [
    { id: 'doc-1', professorId: 'p', importId, courseName: 'Biology 101', content: 'first' },
    { id: 'doc-2', professorId: 'p', importId, courseName: 'Biology 101', content: 'second' }
  ];
  const actions = stagedActions(documents, [[0.1], [0.2]]);
  assert.deepEqual(parseStagedActions(serializeActions(actions)), actions);
  assert.throws(() => parseStagedActions(''), /no documents/);
});

test('a staged batch is addressed separately from the batch it came from', () => {
  assert.equal(vectorBatchName('batch-00007.ndjson'), 'vectors-00007.ndjson');
  assert.notEqual(vectorBatchName('batch-00007.ndjson'), 'batch-00007.ndjson');
});
