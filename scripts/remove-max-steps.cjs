const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { parseArgs } = require('node:util');
const appRequire = createRequire(path.resolve(__dirname, '..', 'ui', 'api', 'policy.js'));
const { AzureCliCredential } = appRequire('@azure/identity');
const { BlobServiceClient } = appRequire('@azure/storage-blob');
const { applyProfessorIdentity, validatePolicy, renderPolicyText } = appRequire('./policy');

function withoutRetiredSteps(policy) {
  const copy = structuredClone(policy);
  delete copy.maxStepsRevealed;
  delete copy.policyText;
  for (const group of copy.courseGroups || []) delete group.maxStepsRevealed;
  return copy;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'storage-account': { type: 'string' },
      'search-endpoint': { type: 'string' },
      'index-name': { type: 'string', default: 'pedagogy-policy-index' },
      'indexer-name': { type: 'string', default: 'pedagogy-policy-idxr' },
      'backup-dir': { type: 'string' },
      apply: { type: 'boolean', default: false }
    }
  });
  if (!/^[a-z0-9]{3,24}$/.test(values['storage-account'] || '')) throw new Error('Provide --storage-account.');
  const endpoint = new URL(values['search-endpoint']);
  if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+\.search\.windows\.net$/.test(endpoint.hostname) ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.username || endpoint.password) {
    throw new Error('Provide an Azure AI Search HTTPS --search-endpoint.');
  }
  if (values.apply && !values['backup-dir']) throw new Error('--apply requires a new --backup-dir outside the repository.');
  if (values.apply) {
    const relative = path.relative(path.resolve(__dirname, '..'), path.resolve(values['backup-dir']));
    if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      throw new Error('The backup directory must be outside the repository.');
    }
  }
  const credential = new AzureCliCredential();
  const token = await credential.getToken('https://search.azure.com/.default');
  if (!token) throw new Error('Azure did not return a Search token.');
  async function search(method, resource, body) {
    const response = await fetch(`${endpoint.origin}${resource}?api-version=2026-04-01`, {
      method,
      headers: { Authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Search ${method} ${resource} failed: HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }
  const indexPath = `/indexes/${encodeURIComponent(values['index-name'])}`;
  const indexerPath = `/indexers/${encodeURIComponent(values['indexer-name'])}`;
  const schema = await search('GET', indexPath);
  const key = schema.fields.find(field => field.key)?.name;
  if (!key) throw new Error('The policy index has no key field.');
  const hasCompatibilityField = schema.fields.some(field => field.name === 'maxStepsRevealed');
  const countBefore = await search('GET', `${indexPath}/docs/$count`);
  const container = new BlobServiceClient(
    `https://${values['storage-account']}.blob.core.windows.net`, credential
  ).getContainerClient('policies');
  const entries = [];
  for await (const item of container.listBlobsFlat()) {
    if (!item.name.endsWith('.json')) continue;
    const client = container.getBlockBlobClient(item.name);
    const response = await client.download();
    const chunks = [];
    for await (const chunk of response.readableStreamBody) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const policy = JSON.parse(raw.toString('utf8'));
    if (!policy.professorId || !policy.professorName) throw new Error(`Missing identity in ${item.name}.`);
    const clean = applyProfessorIdentity(policy, { id: policy.professorId, name: policy.professorName });
    clean.policyText = renderPolicyText(clean, { name: clean.professorName });
    validatePolicy(clean);
    assert.deepEqual(withoutRetiredSteps(clean), withoutRetiredSteps(policy), 'Migration changed another policy setting.');
    const result = await search('POST', `${indexPath}/docs/search`, {
      search: '*', filter: `professorId eq '${policy.professorId.replaceAll("'", "''")}'`, top: 2
    });
    if (result.value.length !== 1) throw new Error(`Expected exactly one indexed policy for ${item.name}.`);
    const document = result.value[0];
    const changed = Object.hasOwn(policy, 'maxStepsRevealed') ||
      policy.courseGroups.some(group => Object.hasOwn(group, 'maxStepsRevealed')) ||
      policy.policyText !== clean.policyText;
    entries.push({
      name: item.name, client, raw, etag: response.etag, clean, changed, document,
      backupName: createHash('sha256').update(item.name).digest('hex')
    });
  }
  if (!entries.length) throw new Error('No saved policies found; refusing an empty migration.');
  console.log(JSON.stringify({
    mode: values.apply ? 'apply' : 'dry-run', policies: entries.length,
    blobsToUpdate: entries.filter(entry => entry.changed).length,
    indexedDocumentsToUpdate: entries.filter(entry =>
      entry.document.policyText !== entry.clean.policyText ||
      hasCompatibilityField && entry.document.maxStepsRevealed != null
    ).length
  }));
  if (!values.apply) return;

  const backupDir = path.resolve(values['backup-dir']);
  await fs.mkdir(backupDir);
  for (const entry of entries) {
    await fs.writeFile(path.join(backupDir, `${entry.backupName}.blob`), entry.raw, { flag: 'wx' });
  }
  await fs.writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify({
    storageAccount: values['storage-account'], index: values['index-name'], countBefore,
    entries: entries.map(({ name, backupName, etag, document }) => ({ name, backupName, etag, document }))
  }, null, 2), { flag: 'wx' });

  for (const entry of entries) {
    if (entry.changed) {
      const body = JSON.stringify(entry.clean);
      const saved = await entry.client.upload(body, Buffer.byteLength(body), {
        conditions: { ifMatch: entry.etag },
        blobHTTPHeaders: { blobContentType: 'application/json' }
      });
      entry.etag = saved.etag;
    }
  }
  const previousRun = (await search('GET', `${indexerPath}/status`)).lastResult?.startTime;
  await search('POST', `${indexerPath}/run`);
  let completed = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const { lastResult } = await search('GET', `${indexerPath}/status`);
    if (lastResult?.startTime !== previousRun && lastResult?.status && lastResult.status !== 'inProgress') {
      if (lastResult.status !== 'success' || lastResult.itemsFailed) throw new Error('Policy indexer did not complete successfully.');
      completed = true;
      break;
    }
  }
  if (!completed) throw new Error('Policy indexer did not complete within the verification window.');
  for (const entry of entries) {
    if ((await entry.client.getProperties()).etag !== entry.etag) {
      throw new Error(`Concurrent policy edit detected for ${entry.name}; do not overwrite its index entry.`);
    }
  }
  const updates = entries.map(entry => ({
    '@search.action': 'merge',
    [key]: entry.document[key],
    policyText: entry.clean.policyText,
    ...(hasCompatibilityField ? { maxStepsRevealed: null } : {})
  }));
  const indexed = await search('POST', `${indexPath}/docs/index`, { value: updates });
  if (indexed.value.length !== updates.length || indexed.value.some(item => !item.status)) {
    throw new Error('One or more indexed policy updates failed.');
  }
  for (const entry of entries) {
    const properties = await entry.client.getProperties();
    if (properties.etag !== entry.etag) throw new Error(`Concurrent policy edit detected during verification of ${entry.name}.`);
    const stored = JSON.parse((await entry.client.downloadToBuffer()).toString('utf8'));
    assert.deepEqual(stored, entry.clean);
    const document = await search('GET', `${indexPath}/docs/${encodeURIComponent(entry.document[key])}`);
    assert.equal(document.policyText, entry.clean.policyText);
    if (hasCompatibilityField) assert.equal(document.maxStepsRevealed, null);
  }
  assert.equal(await search('GET', `${indexPath}/docs/$count`), countBefore, 'Policy index document count changed.');
  console.log(JSON.stringify({ status: 'verified', policies: entries.length, indexDocumentCount: countBefore, backupDir }));
}

main().catch(error => { console.error(`Step-control migration failed: ${error.message}`); process.exitCode = 1; });
