const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { createRequire } = require('node:module');
const { embeddingInput } = require('../functions/src/indexing');
const appRequire = createRequire(path.resolve(__dirname, '..', 'ui', 'api', 'policy.js'));
const { applyProfessorIdentity, renderPolicyText, validatePolicy } = appRequire('./policy');

const courses = [
  { id: 'BIO201', description: 'Introductory Microbiology', helpLevel: 'guided' },
  { id: 'BIO310', description: 'Advanced Microbiology', helpLevel: 'worked_example' },
  { id: 'BIO410', description: 'Quantitative Microbiology', helpLevel: 'full_solution' }
];

function createDemoPolicy(policy) {
  const next = applyProfessorIdentity(policy, { id: policy.professorId, name: policy.professorName });
  next.courseGroups = courses.map(({ id, description, helpLevel }) => {
    const previous = policy.courseGroups.find(group =>
      group.courses.some(course => course.id.trim().toUpperCase() === id));
    return {
      name: `${id} - ${description}`,
      courses: [{ id, description }],
      helpLevel,
      citationsRequired: previous?.citationsRequired ?? policy.citationsRequired
    };
  });
  next.policyText = renderPolicyText(next, { name: next.professorName });
  validatePolicy(next);
  return next;
}

function validateCourseDocuments(documents, courseName) {
  const code = courseName.split(' ')[0].toLowerCase();
  assert(documents.length > 0, `${courseName} has no material.`);
  const ids = new Set();
  for (const document of documents) {
    assert.equal(document.courseName, courseName, 'Course metadata does not match its content pack.');
    assert(document.id.startsWith(`${code}-`) && !ids.has(document.id), 'Duplicate or incorrectly scoped document ID.');
    ids.add(document.id);
    for (const field of ['title', 'subject', 'url', 'content']) {
      assert.equal(typeof document[field], 'string', `Missing ${field}.`);
      assert(document[field].trim(), `Empty ${field}.`);
    }
    assert(document.title.startsWith(`${code.toUpperCase()}:`), 'Titles must identify the course.');
  }
  return documents;
}

async function main() {
  const { values } = parseArgs({ options: {
    'storage-account': { type: 'string' },
    'search-endpoint': { type: 'string' },
    'openai-endpoint': { type: 'string' },
    'professor-id': { type: 'string' },
    'backup-dir': { type: 'string' },
    apply: { type: 'boolean', default: false }
  } });
  assert(/^[a-z0-9]{3,24}$/.test(values['storage-account'] || ''), 'Provide --storage-account.');
  assert(/^[\w-]+$/.test(values['professor-id'] || ''), 'Provide --professor-id.');
  for (const [argument, suffix] of [['search-endpoint', 'search.windows.net'], ['openai-endpoint', 'openai.azure.com']]) {
    const url = new URL(values[argument]);
    assert(url.protocol === 'https:' && url.hostname.endsWith(`.${suffix}`) &&
      /^[a-z0-9-]+$/.test(url.hostname.slice(0, -suffix.length - 1)) &&
      url.pathname === '/' && !url.port && !url.search && !url.hash && !url.username && !url.password,
    `Provide an Azure HTTPS --${argument}.`);
  }
  if (values.apply) {
    assert(values['backup-dir'], '--apply requires a new --backup-dir outside the repository.');
    const relative = path.relative(path.resolve(__dirname, '..'), path.resolve(values['backup-dir']));
    assert(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'Backups must be outside the repository.');
  }
  const { AzureCliCredential } = appRequire('@azure/identity');
  const { BlobServiceClient } = appRequire('@azure/storage-blob');
  const credential = new AzureCliCredential();
  const searchToken = await credential.getToken('https://search.azure.com/.default');
  async function search(method, resource, body) {
    const response = await fetch(`${values['search-endpoint'].replace(/\/$/, '')}${resource}?api-version=2026-04-01`, {
      method, headers: { authorization: `Bearer ${searchToken.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Search ${resource}: HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }
  const index = '/indexes/course-content-index';
  const schema = await search('GET', index);
  assert.equal(schema.fields.find(field => field.key)?.name, 'id');
  assert.equal(schema.fields.find(field => field.name === 'courseName')?.filterable, true);
  assert.equal(schema.fields.find(field => field.name === 'contentVector')?.dimensions, 1536);
  async function readDocuments() {
    const result = await search('POST', `${index}/docs/search`, { search: '*', count: true, top: 1000 });
    assert.equal(result.value.length, result['@odata.count'], 'Index exceeds the safe inventory limit.');
    return result.value.map(({ '@search.score': score, ...document }) => document);
  }
  const before = await readDocuments();
  const existing = new Map(before.map(document => [document.id, document]));
  const client = new BlobServiceClient(
    `https://${values['storage-account']}.blob.core.windows.net`, credential
  ).getContainerClient('policies').getBlockBlobClient(`${values['professor-id']}.json`);
  const downloaded = await client.download();
  const buffers = [];
  for await (const buffer of downloaded.readableStreamBody) buffers.push(buffer);
  const raw = Buffer.concat(buffers);
  const originalPolicy = JSON.parse(raw.toString('utf8'));
  assert.equal(originalPolicy.professorId, values['professor-id']);
  validatePolicy(originalPolicy);
  const policy = createDemoPolicy(originalPolicy);
  const policyChanged = JSON.stringify(policy) !== JSON.stringify(originalPolicy);
  const policyIndex = '/indexes/pedagogy-policy-index';
  const policySchema = await search('GET', policyIndex);
  const policyKey = policySchema.fields.find(field => field.key)?.name;
  assert(policyKey, 'Policy index has no key.');
  const policyResult = await search('POST', `${policyIndex}/docs/search`, {
    search: '*', filter: `professorId eq '${values['professor-id']}'`, top: 2
  });
  assert.equal(policyResult.value.length, 1, 'Expected exactly one indexed policy for the selected professor.');
  const policyDocument = policyResult.value[0];
  const desired = [];
  for (const course of courses.slice(1)) {
    const filename = `${course.id.toLowerCase()}.json`;
    const documents = validateCourseDocuments(
      JSON.parse(await fs.readFile(path.join(__dirname, 'seed-data', filename), 'utf8')),
      `${course.id} ${course.description}`
    );
    for (const document of documents) {
      assert(!existing.has(document.id) || existing.get(document.id).professorId === policy.professorId,
        `Document ${document.id} belongs to another professor.`);
      desired.push({
        ...document, professorId: policy.professorId, importId: 'biology-demo-v1',
        sourcePath: `scripts/seed-data/${filename}`, resourceIdentifier: document.id,
        chunkNumber: 1, chunkCount: 1, isActive: true,
        contentHash: createHash('sha256').update(embeddingInput(document)).digest('hex')
      });
    }
  }
  const changes = desired.filter(document =>
    Object.entries(document).some(([key, value]) => existing.get(document.id)?.[key] !== value));
  const introSeeds = JSON.parse(await fs.readFile(path.join(__dirname, 'seed-data', 'microbiology.json'), 'utf8'));
  const intro = introSeeds.map(document => existing.get(document.id)).filter(Boolean);
  assert.equal(intro.length, introSeeds.length, 'Expected the existing BIO201 material; refusing a partial catalog.');
  const introName = `${courses[0].id} ${courses[0].description}`;
  const introChanges = intro.filter(document => document.courseName !== introName);
  console.log(JSON.stringify({
    mode: values.apply ? 'apply' : 'dry-run', professorId: policy.professorId,
    removedCourses: originalPolicy.courseGroups.flatMap(group => group.courses)
      .filter(course => !courses.some(keep => keep.id === course.id)).map(course => course.id),
    groups: policy.courseGroups, policyChanged, documentsToEmbed: changes.length,
    bio201MetadataUpdates: introChanges.length, existingDocumentCount: before.length
  }));
  if (!values.apply) return;

  await fs.mkdir(values['backup-dir']);
  await fs.writeFile(path.join(values['backup-dir'], 'policy.blob'), raw, { flag: 'wx' });
  await fs.writeFile(path.join(values['backup-dir'], 'manifest.json'), JSON.stringify({
    storageAccount: values['storage-account'], blobName: client.name, etag: downloaded.etag,
    policyDocument, courseSchema: schema, courseDocuments: before
  }, null, 2), { flag: 'wx' });
  const uploaded = [];
  if (changes.length) {
    const token = await credential.getToken('https://cognitiveservices.azure.com/.default');
    const response = await fetch(`${values['openai-endpoint'].replace(/\/$/, '')}/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-10-21`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ input: changes.map(embeddingInput), dimensions: 1536 }),
      signal: AbortSignal.timeout(120000)
    });
    if (!response.ok) throw new Error(`Embedding failed: HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const embeddings = (await response.json()).data.sort((a, b) => a.index - b.index);
    assert.equal(embeddings.length, changes.length);
    embeddings.forEach((item, index) => {
      assert.equal(item.index, index);
      assert.equal(item.embedding.length, 1536);
      assert(item.embedding.every(Number.isFinite));
      uploaded.push({
        '@search.action': 'mergeOrUpload', ...changes[index], contentVector: item.embedding,
        importedAt: new Date().toISOString()
      });
    });
  }
  uploaded.push(...introChanges.map(document => ({
    '@search.action': 'merge', id: document.id, courseName: introName
  })));
  async function indexDocuments(indexPath, documents) {
    if (!documents.length) return;
    const result = await search('POST', `${indexPath}/docs/index`, { value: documents });
    assert.equal(result.value.length, documents.length);
    assert(result.value.every(item => item.status), JSON.stringify(result.value));
  }
  await indexDocuments(index, uploaded);
  let verified = false;
  const expectedCount = before.length + desired.filter(document => !existing.has(document.id)).length;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const after = await readDocuments();
    const lookup = new Map(after.map(document => [document.id, document]));
    if (after.length !== expectedCount || desired.some(document =>
      Object.entries(document).some(([key, value]) => lookup.get(document.id)?.[key] !== value)) ||
      intro.some(document => lookup.get(document.id)?.courseName !== introName)) continue;
    for (const document of before) {
      if (desired.some(next => next.id === document.id)) continue;
      assert.deepEqual(lookup.get(document.id), intro.some(item => item.id === document.id)
        ? { ...document, courseName: introName } : document, 'An unrelated document changed.');
    }
    verified = true;
    break;
  }
  assert(verified, 'Course upload did not become visible within the verification window.');
  let etag = downloaded.etag;
  if (policyChanged) {
    const body = JSON.stringify(policy);
    etag = (await client.upload(body, Buffer.byteLength(body), {
      conditions: { ifMatch: etag }, blobHTTPHeaders: { blobContentType: 'application/json' }
    })).etag;
  }
  assert.equal((await client.getProperties()).etag, etag, 'Concurrent policy edit; refusing to overwrite its index.');
  await indexDocuments(policyIndex, [{
    '@search.action': 'merge', [policyKey]: policyDocument[policyKey], policyText: policy.policyText
  }]);
  assert.equal((await client.getProperties()).etag, etag, 'Concurrent policy edit during verification.');
  assert.deepEqual(JSON.parse((await client.downloadToBuffer()).toString('utf8')), policy);
  let policyVerified = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const indexed = await search('GET', `${policyIndex}/docs/${encodeURIComponent(policyDocument[policyKey])}`);
    if (indexed.policyText === policy.policyText) { policyVerified = true; break; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert(policyVerified, 'Indexed teaching policy did not become visible.');
  console.log(JSON.stringify({
    status: 'verified', totalDocuments: expectedCount, newCourseDocuments: desired.length,
    bio201DocumentsPreserved: intro.length, policyText: policy.policyText, backupDir: values['backup-dir']
  }));
}

module.exports = { createDemoPolicy, validateCourseDocuments };
if (require.main === module) {
  main().catch(error => { console.error(`Biology demo population failed: ${error.message}`); process.exitCode = 1; });
}
