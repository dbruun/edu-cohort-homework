const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// The import API is only meaningful end to end: routing, professor ownership,
// SAS scope, and state transitions all live outside the pure helpers. Stub the
// Azure SDKs at the module boundary so the real server code runs unmodified.
const state = {
  entities: new Map(),
  blobs: new Map(),
  deletedBlobs: [],
  sasRequests: []
};

function stubModule(request, exports) {
  const filename = require.resolve(request);
  const stub = new Module(filename);
  stub.filename = filename;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[filename] = stub;
}

class FakeBlockBlobClient {
  constructor(containerName, blobName) {
    this.blobName = blobName;
    this.url = `https://testaccount.blob.core.windows.net/${containerName}/${blobName}`;
  }

  async exists() {
    return state.blobs.has(this.blobName);
  }

  async getProperties() {
    return { contentLength: state.blobs.get(this.blobName).contentLength };
  }

  async deleteIfExists() {
    state.deletedBlobs.push(this.blobName);
    return { succeeded: state.blobs.delete(this.blobName) };
  }
}

class FakeTableClient {
  async createEntity(entity) {
    state.entities.set(`${entity.partitionKey}|${entity.rowKey}`, { ...entity });
  }

  async getEntity(partitionKey, rowKey) {
    const entity = state.entities.get(`${partitionKey}|${rowKey}`);
    if (!entity) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    return { ...entity };
  }

  async updateEntity(entity) {
    state.entities.set(`${entity.partitionKey}|${entity.rowKey}`, { ...entity });
  }

  async deleteEntity(partitionKey, rowKey) {
    state.entities.delete(`${partitionKey}|${rowKey}`);
  }
}

stubModule('@azure/identity', { DefaultAzureCredential: class {} });
stubModule('@azure/data-tables', { TableClient: FakeTableClient });
stubModule('@azure/storage-blob', {
  BlobSASPermissions: { parse: (permissions) => ({ toString: () => permissions }) },
  SASProtocol: { Https: 'https' },
  BlobServiceClient: class {
    async getUserDelegationKey(startsOn, expiresOn) {
      return { startsOn, expiresOn, value: 'delegation-key' };
    }

    getContainerClient(containerName) {
      return { getBlockBlobClient: (blobName) => new FakeBlockBlobClient(containerName, blobName) };
    }
  },
  generateBlobSASQueryParameters: (options, delegationKey, accountName) => {
    state.sasRequests.push({ options, delegationKey, accountName });
    return { toString: () => 'sv=2025-01-05&sig=test-signature' };
  }
});

process.env.POLICY_STORAGE_ACCOUNT = 'testaccount';
const { server } = require('../../server');

// Easy Auth injects the encoded principal on every authenticated request, and
// the portal now requires it, so the fixtures have to look like the real thing.
function easyAuthHeaders(id, name) {
  const principal = { userId: id, userDetails: name, claims: [{ typ: 'oid', val: id }, { typ: 'name', val: name }] };
  return {
    'x-ms-client-principal-id': id,
    'x-ms-client-principal-name': name,
    'x-ms-client-principal': Buffer.from(JSON.stringify(principal)).toString('base64url')
  };
}

const professor = easyAuthHeaders('professor-a', 'Professor A');
const otherProfessor = easyAuthHeaders('professor-b', 'Professor B');
const fiveGigabytes = 5 * 1024 * 1024 * 1024;
let origin;
let created;

async function call(method, path, { headers = {}, body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test('issues a write-only SAS for a multi-gigabyte upload without receiving the file', async () => {
  const response = await call('POST', '/api/imscc-imports', {
    headers: professor,
    body: { originalFileName: 'Biology 101.imscc', fileSize: fiveGigabytes }
  });
  created = response.body;

  assert.equal(response.status, 201);
  assert.equal(created.status, 'uploading');
  assert.match(created.importId, /^[0-9a-f-]{36}$/);
  // The browser must send the bytes to Blob Storage, never to App Service.
  assert.ok(created.uploadUrl.startsWith('https://testaccount.blob.core.windows.net/raw-imscc/'));
  assert.ok(created.uploadUrl.includes('?sv='));
  assert.ok(new Date(created.expiresAt).getTime() > Date.now());
  // The response must not leak internal storage layout.
  assert.deepEqual(Object.keys(created).sort(), ['expiresAt', 'importId', 'status', 'uploadUrl']);

  const [{ options, accountName }] = state.sasRequests;
  assert.equal(accountName, 'testaccount');
  assert.equal(options.containerName, 'raw-imscc');
  assert.equal(options.permissions.toString(), 'cw', 'the SAS must not grant read or delete');
  assert.equal(options.protocol, 'https');
  assert.ok(options.blobName.endsWith(`/${created.importId}/course.imscc`));
  assert.ok(
    options.expiresOn.getTime() - options.startsOn.getTime() <= 25 * 60 * 60 * 1000,
    'a short-lived SAS must not outlive a day'
  );

  const [entity] = [...state.entities.values()];
  assert.equal(entity.status, 'uploading');
  assert.equal(entity.expectedBytes, fiveGigabytes);
  assert.ok(!entity.partitionKey.includes('professor-a'), 'the partition key must not expose the professor id');
});

test('refuses an unauthenticated import request', async () => {
  const response = await call('POST', '/api/imscc-imports', {
    body: { originalFileName: 'course.imscc', fileSize: 10 }
  });
  assert.equal(response.status, 401);
});

test('reports the committed blob size once the direct upload finishes', async () => {
  const [entity] = [...state.entities.values()];
  state.blobs.set(entity.blobName, { contentLength: fiveGigabytes });

  const response = await call('GET', `/api/imscc-imports/${created.importId}`, { headers: professor });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'uploaded');
  assert.equal(response.body.uploadedBytes, fiveGigabytes);
  assert.equal(response.body.originalFileName, 'Biology 101.imscc');
  assert.equal(state.entities.get(`${entity.partitionKey}|${entity.rowKey}`).status, 'uploaded');
});

test('hides an import from every other professor', async () => {
  const read = await call('GET', `/api/imscc-imports/${created.importId}`, { headers: otherProfessor });
  assert.equal(read.status, 404);
  const cancel = await call('POST', `/api/imscc-imports/${created.importId}/cancel`, { headers: otherProfessor });
  assert.equal(cancel.status, 404);
});

test('rejects malformed and traversing import ids before reaching storage', async () => {
  for (const importId of ['not-a-uuid', '..%2F..%2Fpolicies', '00000000-0000-0000-0000-000000000000']) {
    const response = await call('GET', `/api/imscc-imports/${importId}`, { headers: professor });
    assert.equal(response.status, 404, `${importId} must not be treated as an import`);
  }
});

test('cancels an upload and removes the abandoned archive', async () => {
  const [entity] = [...state.entities.values()];
  const response = await call('POST', `/api/imscc-imports/${created.importId}/cancel`, { headers: professor });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'cancelled');
  assert.equal(response.body.cancellationRequested, true);
  assert.ok(state.deletedBlobs.includes(entity.blobName), 'the cancelled archive must not be left behind');
});

test('refuses to cancel an import that already finished', async () => {
  const response = await call('POST', `/api/imscc-imports/${created.importId}/cancel`, { headers: professor });
  assert.equal(response.status, 409);
  assert.match(response.body.error, /no longer be cancelled/);
});
