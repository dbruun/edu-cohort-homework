const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { parseArgs } = require('node:util');
const appRequire = createRequire(path.resolve(__dirname, '..', 'ui', 'api', 'imports.js'));
const { professorPartitionKey, publicImport } = appRequire('./imports');

const seedId = 'coursewise-biology-uploads-v1';
const courseDocumentCounts = { BIO201: 6, BIO310: 9, BIO410: 12 };

function demoUploads(policy, now = new Date()) {
  assert(policy.professorId && policy.professorName, 'A saved professor identity is required.');
  const courses = policy.courseGroups.flatMap(group => group.courses);
  return ['BIO201', 'BIO310', 'BIO410'].map((id, index) => {
    const course = courses.find(course => course.id === id);
    assert(course?.description, `${id} must belong to this professor's saved policy.`);
    const createdAt = new Date(now.getTime() - (index + 1) * 60 * 60 * 1000);
    const bytes = [10485760, 15728640, 12582912][index];
    return {
      partitionKey: professorPartitionKey(policy.professorId),
      rowKey: `d3e0${id.slice(3).padStart(4, '0')}-0000-4000-8000-000000000001`,
      professorId: policy.professorId,
      professorName: policy.professorName,
      originalFileName: `${id}-demo-course.imscc`,
      courseName: `${id} - ${course.description}`,
      courseNameSource: 'demo',
      status: 'complete',
      isDemo: true,
      demoSeedId: seedId,
      expectedBytes: bytes,
      uploadedBytes: bytes,
      documentsDiscovered: courseDocumentCounts[id],
      documentsIndexed: courseDocumentCounts[id],
      createdAt,
      updatedAt: new Date(createdAt.getTime() + 2 * 60 * 1000)
    };
  });
}

async function seedUploads(table, entities, apply = false) {
  const plan = [];
  for (const entity of entities) {
    let existing;
    try {
      existing = await table.getEntity(entity.partitionKey, entity.rowKey);
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
    if (existing) {
      assert(existing.isDemo === true && existing.demoSeedId === seedId &&
        existing.professorId === entity.professorId &&
        existing.originalFileName === entity.originalFileName &&
        existing.courseName === entity.courseName && existing.status === 'complete',
      `Refusing to overwrite an unrelated or changed import: ${entity.rowKey}`);
      assert(new Date(existing.createdAt).getTime() >= Date.now() - 30 * 24 * 60 * 60 * 1000,
        'Existing demo history has expired from the portal listing; review it before reseeding.');
    }
    const countChanged = existing &&
      (Number(existing.documentsDiscovered) !== entity.documentsDiscovered ||
        Number(existing.documentsIndexed) !== entity.documentsIndexed);
    plan.push({ entity, action: !existing ? 'create' : countChanged ? 'update-count' : 'keep' });
  }
  if (apply) {
    for (const item of plan) {
      if (item.action === 'create') {
        await table.createEntity(item.entity);
        console.error(`Created demo upload history: ${item.entity.courseName}`);
      } else if (item.action === 'update-count') {
        await table.updateEntity({
          partitionKey: item.entity.partitionKey,
          rowKey: item.entity.rowKey,
          documentsDiscovered: item.entity.documentsDiscovered,
          documentsIndexed: item.entity.documentsIndexed
        }, 'Merge');
        console.error(`Updated demo document count: ${item.entity.courseName}`);
      }
    }
    for (const item of plan) {
      const stored = await table.getEntity(item.entity.partitionKey, item.entity.rowKey);
      const actual = publicImport(stored);
      assert(actual.isDemo && actual.status === 'complete' &&
        actual.courseName === item.entity.courseName &&
        actual.documentsDiscovered === item.entity.documentsDiscovered &&
        actual.documentsIndexed === item.entity.documentsIndexed,
      `Demo history read-back failed for ${item.entity.rowKey}`);
    }
  }
  return plan.map(({ entity, action }) => ({ importId: entity.rowKey, courseName: entity.courseName, action }));
}

async function main() {
  const { values } = parseArgs({ options: {
    'storage-account': { type: 'string' },
    'professor-id': { type: 'string' },
    table: { type: 'string', default: 'ImsccImports' },
    apply: { type: 'boolean', default: false }
  } });
  assert(/^[a-z0-9]{3,24}$/.test(values['storage-account'] || ''), 'Provide --storage-account.');
  assert(/^[\w-]+$/.test(values['professor-id'] || ''), 'Provide --professor-id.');
  assert(/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(values.table), 'Provide a valid --table.');
  const { AzureCliCredential } = appRequire('@azure/identity');
  const { BlobServiceClient } = appRequire('@azure/storage-blob');
  const { TableClient } = appRequire('@azure/data-tables');
  const credential = new AzureCliCredential();
  const account = values['storage-account'];
  const blob = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential)
    .getContainerClient('policies').getBlockBlobClient(`${values['professor-id']}.json`);
  const policy = JSON.parse((await blob.downloadToBuffer()).toString('utf8'));
  assert.equal(policy.professorId, values['professor-id'], 'Saved policy identity does not match the requested professor.');
  const table = new TableClient(`https://${account}.table.core.windows.net`, values.table, credential);
  const records = await seedUploads(table, demoUploads(policy), values.apply);
  console.log(JSON.stringify({ store: 'Azure Table Storage', table: values.table, applied: values.apply, records }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { demoUploads, seedUploads, seedId, courseDocumentCounts };
