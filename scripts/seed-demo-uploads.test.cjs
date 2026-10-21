const test = require('node:test');
const assert = require('node:assert/strict');
const { courseDocumentCounts, demoUploads, seedUploads } = require('./seed-demo-uploads.cjs');

const policy = {
  professorId: 'test-professor',
  professorName: 'Demo Professor',
  courseGroups: [{
    courses: [
      { id: 'BIO201', description: 'Introductory Microbiology' },
      { id: 'BIO310', description: 'Advanced Microbiology' },
      { id: 'BIO410', description: 'Quantitative Microbiology' }
    ]
  }]
};

function fakeTable(initial = []) {
  const rows = new Map(initial.map(row => [row.rowKey, structuredClone(row)]));
  return {
    rows,
    creates: 0,
    async getEntity(partitionKey, rowKey) {
      const row = rows.get(rowKey);
      if (!row || row.partitionKey !== partitionKey) throw Object.assign(new Error('Not found'), { statusCode: 404 });
      return structuredClone(row);
    },
    async createEntity(entity) {
      assert(!rows.has(entity.rowKey), 'A seed must never overwrite an existing row.');
      rows.set(entity.rowKey, structuredClone(entity));
      this.creates++;
    },
    async updateEntity(entity, mode) {
      assert.equal(mode, 'Merge');
      const existing = rows.get(entity.rowKey);
      assert(existing, 'A seed must not create missing rows through update.');
      rows.set(entity.rowKey, { ...existing, ...structuredClone(entity) });
    }
  };
}

test('demo history is explicitly fabricated, terminal, and limited to the saved biology courses', () => {
  const records = demoUploads(policy);
  assert.equal(records.length, 3);
  assert.equal(new Set(records.map(record => record.rowKey)).size, 3);
  for (const record of records) {
    assert.equal(record.isDemo, true);
    assert.equal(record.status, 'complete');
    assert.equal(record.professorId, policy.professorId);
    assert.equal(Object.hasOwn(record, 'blobName'), false);
    assert.match(record.rowKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  assert.deepEqual(records.map(record => record.documentsIndexed), [6, 9, 12]);
  assert.equal(new Set(records.map(record => record.documentsIndexed)).size, 3);
  assert.throws(() => demoUploads({ ...policy, courseGroups: [] }), /must belong/);
});

test('seeding is dry-run by default, idempotent, and preserves real uploads', async () => {
  const records = demoUploads(policy);
  const real = { partitionKey: records[0].partitionKey, rowKey: 'real-upload', status: 'complete', originalFileName: 'real.imscc' };
  const table = fakeTable([real]);
  const plan = await seedUploads(table, records);
  assert(plan.every(item => item.action === 'create'));
  assert.equal(table.creates, 0);
  await seedUploads(table, records, true);
  const repeat = await seedUploads(table, records, true);
  assert(repeat.every(item => item.action === 'keep'));
  assert.equal(table.creates, 3);
  assert.deepEqual(table.rows.get(real.rowKey), real);
});

test('a collision with real history stops the entire preflight before any writes', async () => {
  const records = demoUploads(policy);
  const table = fakeTable([{ ...records[1], isDemo: false }]);
  await assert.rejects(seedUploads(table, records, true), /Refusing to overwrite/);
  assert.equal(table.creates, 0);
});

test('a rerun updates only discovered and indexed counts on owned demo rows', async () => {
  const previous = demoUploads(policy).map(record => ({
    ...record,
    documentsDiscovered: 8,
    documentsIndexed: 8,
    updatedAt: new Date('2026-10-19T12:00:00Z')
  }));
  const table = fakeTable(previous);
  assert.deepEqual((await seedUploads(table, demoUploads(policy))).map(item => item.action),
    ['update-count', 'update-count', 'update-count']);
  await seedUploads(table, demoUploads(policy), true);
  for (const expected of demoUploads(policy)) {
    const actual = table.rows.get(expected.rowKey);
    assert.equal(actual.documentsDiscovered, expected.documentsDiscovered);
    assert.equal(actual.documentsIndexed, expected.documentsIndexed);
    assert.equal(actual.updatedAt.getTime(), previous.find(row => row.rowKey === expected.rowKey).updatedAt.getTime());
    assert.equal(actual.courseName, expected.courseName);
    assert.equal(actual.originalFileName, expected.originalFileName);
  }
  assert.deepEqual((await seedUploads(table, demoUploads(policy))).map(item => item.action),
    ['keep', 'keep', 'keep']);
});

test('storage errors are not mistaken for missing demo history', async () => {
  const table = { async getEntity() { throw Object.assign(new Error('Forbidden'), { statusCode: 403 }); } };
  await assert.rejects(seedUploads(table, demoUploads(policy), true), /Forbidden/);
});
