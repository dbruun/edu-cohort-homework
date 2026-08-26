const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_LIST_LIMIT,
  listLimit,
  nextCancelState,
  professorPartitionKey,
  publicImport,
  sortRecentFirst,
  validateCreateImport
} = require('../imports');

test('lists imports newest first so returning to the portal shows current work', () => {
  const sorted = sortRecentFirst([
    { importId: 'older', createdAt: '2026-01-01T00:00:00Z' },
    { importId: 'newest', createdAt: '2026-01-03T00:00:00Z' },
    { importId: 'middle', createdAt: '2026-01-02T00:00:00Z' }
  ]);
  assert.deepEqual(sorted.map((record) => record.importId), ['newest', 'middle', 'older']);
});

test('orders imports by when they started, not by when they last moved', () => {
  // updatedAt advances as the pipeline works, so ordering by it would reshuffle
  // the list under a professor who is reading it.
  const sorted = sortRecentFirst([
    { importId: 'started-first', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-09T00:00:00Z' },
    { importId: 'started-second', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' }
  ]);
  assert.deepEqual(sorted.map((record) => record.importId), ['started-second', 'started-first']);
});

test('orders identical timestamps deterministically', () => {
  const records = [
    { importId: 'aaa', createdAt: '2026-01-01T00:00:00Z' },
    { importId: 'bbb', createdAt: '2026-01-01T00:00:00Z' }
  ];
  assert.deepEqual(
    sortRecentFirst(records).map((r) => r.importId),
    sortRecentFirst([...records].reverse()).map((r) => r.importId)
  );
});

test('does not reorder the caller\'s array', () => {
  const records = [
    { importId: 'older', createdAt: '2026-01-01T00:00:00Z' },
    { importId: 'newer', createdAt: '2026-01-02T00:00:00Z' }
  ];
  sortRecentFirst(records);
  assert.equal(records[0].importId, 'older');
});

test('bounds how many imports a single request can ask for', () => {
  assert.equal(listLimit(undefined), DEFAULT_LIST_LIMIT);
  assert.equal(listLimit(''), DEFAULT_LIST_LIMIT);
  assert.equal(listLimit(5), 5);
  assert.equal(listLimit('5'), 5);
  assert.equal(listLimit(10_000), 100, 'an unbounded request would scan a whole partition');
  assert.throws(() => listLimit(0), /positive integer/);
  assert.throws(() => listLimit(-1), /positive integer/);
  assert.throws(() => listLimit('all'), /positive integer/);
});

test('accepts a large IMSCC upload without imposing an application size limit', () => {
  assert.deepEqual(validateCreateImport({
    originalFileName: 'Biology 101.imscc',
    fileSize: 5 * 1024 * 1024 * 1024
  }), {
    originalFileName: 'Biology 101.imscc',
    fileSize: 5 * 1024 * 1024 * 1024
  });
});

test('rejects missing, empty, and non-IMSCC uploads', () => {
  assert.throws(() => validateCreateImport(), /must be an object/);
  assert.throws(() => validateCreateImport({ originalFileName: 'course.zip', fileSize: 10 }), /Choose an IMSCC file/);
  assert.throws(() => validateCreateImport({ originalFileName: 'course.imscc', fileSize: 0 }), /positive integer/);
});

test('uses a deterministic non-identifying professor partition key', () => {
  const key = professorPartitionKey('professor-object-id');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, professorPartitionKey('professor-object-id'));
  assert.ok(!key.includes('professor-object-id'));
});

test('returns only public import status fields', () => {
  assert.deepEqual(publicImport({
    partitionKey: 'private-partition',
    rowKey: 'import-id',
    blobName: 'private/blob/path',
    status: 'uploaded',
    originalFileName: 'course.imscc',
    expectedBytes: 100,
    uploadedBytes: 100,
    createdAt: 'created',
    updatedAt: 'updated'
  }), {
    importId: 'import-id',
    status: 'uploaded',
    originalFileName: 'course.imscc',
    expectedBytes: 100,
    uploadedBytes: 100,
    courseName: undefined,
    courseNameSource: undefined,
    documentsDiscovered: 0,
    documentsIndexed: 0,
    cancellationRequested: false,
    error: undefined,
    createdAt: 'created',
    updatedAt: 'updated'
  });
});

test('cancels an import outright before a downstream stage owns it', () => {
  const now = new Date('2026-08-20T00:00:00Z');
  for (const status of ['uploading', 'uploaded', 'queued']) {
    const cancelled = nextCancelState({ status, blobName: 'raw/blob' }, now);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancellationRequested, true);
    assert.equal(cancelled.updatedAt, now);
  }
});

test('records an advisory cancellation while work is in flight', () => {
  const now = new Date('2026-08-20T00:00:00Z');
  for (const status of ['extracting', 'indexing']) {
    const cancelled = nextCancelState({ status }, now);
    assert.equal(cancelled.status, status);
    assert.equal(cancelled.cancellationRequested, true);
  }
});

test('refuses to cancel an import that already reached a terminal state', () => {
  const now = new Date('2026-08-20T00:00:00Z');
  for (const status of ['complete', 'cancelled', 'failed-validation', 'failed-processing', 'failed-indexing', 'upload-expired']) {
    assert.throws(
      () => nextCancelState({ status }, now),
      (error) => error.httpStatus === 409 && /no longer be cancelled/.test(error.message)
    );
  }
});
