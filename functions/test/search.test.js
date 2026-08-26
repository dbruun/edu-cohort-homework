'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(request, exports) {
  const filename = require.resolve(request);
  const stub = new Module(filename);
  stub.filename = filename;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[filename] = stub;
}

stubModule('@azure/identity', { DefaultAzureCredential: class {} });

const { embedTexts, requestWithRetry, retryDelayMs, retryable, uploadActions } = require('../src/search');

function response({ status = 200, body = {}, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] },
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

function recorder(responses) {
  const calls = [];
  const remaining = [...responses];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const next = remaining.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  };
}

test('retries throttling and eventually succeeds', async () => {
  const { calls, fetchImpl } = recorder([
    response({ status: 429, headers: { 'retry-after': '0' } }),
    response({ status: 503 }),
    response({ status: 200, body: { ok: true } })
  ]);
  const slept = [];

  const result = await requestWithRetry('https://example', {}, {
    fetchImpl,
    sleep: async (ms) => { slept.push(ms); },
    baseDelayMs: 10
  });

  assert.equal(result.status, 200);
  assert.equal(calls.length, 3);
  assert.deepEqual(slept, [0, 20], 'Retry-After must win over the local backoff, which then grows');
});

test('does not waste attempts on a request that will always be rejected', async () => {
  const { calls, fetchImpl } = recorder([response({ status: 400, body: { error: 'bad field' } })]);

  await assert.rejects(
    requestWithRetry('https://example', {}, { fetchImpl, sleep: async () => {}, baseDelayMs: 1 }),
    /HTTP 400/
  );
  assert.equal(calls.length, 1, 'a permanent failure must not be retried');
});

test('gives up after the attempt budget rather than retrying forever', async () => {
  const { calls, fetchImpl } = recorder([
    response({ status: 429 }), response({ status: 429 }), response({ status: 429 })
  ]);

  await assert.rejects(
    requestWithRetry('https://example', {}, { fetchImpl, sleep: async () => {}, maxAttempts: 3, baseDelayMs: 1 }),
    /HTTP 429/
  );
  assert.equal(calls.length, 3);
});

test('retries a transport failure, which has no status at all', async () => {
  const { calls, fetchImpl } = recorder([new Error('socket hang up'), response({ status: 200 })]);

  const result = await requestWithRetry('https://example', {}, { fetchImpl, sleep: async () => {}, baseDelayMs: 1 });

  assert.equal(result.status, 200);
  assert.equal(calls.length, 2);
});

test('classifies which failures are worth retrying', () => {
  for (const status of [408, 429, 500, 503]) assert.equal(retryable(status), true, `${status} is transient`);
  for (const status of [400, 401, 403, 404, 413]) assert.equal(retryable(status), false, `${status} is permanent`);
  assert.equal(retryDelayMs(response({ headers: { 'retry-after': '7' } }), 1, 1000), 7000);
  assert.equal(retryDelayMs(response(), 3, 100), 400);
});

test('pairs every text with its own embedding, whatever order the service answers in', async () => {
  const { fetchImpl } = recorder([response({
    status: 200,
    body: { data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }
  })]);

  const vectors = await embedTexts(['first', 'second'], {
    openAiEndpoint: 'https://ai.example',
    token: 'token',
    fetchImpl,
    sleep: async () => {}
  });

  assert.deepEqual(vectors, [[1], [2]], 'an out-of-order response must not misalign vectors');
});

test('refuses a short embedding response instead of indexing mismatched vectors', async () => {
  const { fetchImpl } = recorder([response({ status: 200, body: { data: [{ index: 0, embedding: [1] }] } })]);

  await assert.rejects(
    embedTexts(['first', 'second'], { openAiEndpoint: 'https://ai.example', token: 'token', fetchImpl, sleep: async () => {} }),
    /returned 1 vectors for 2 inputs/
  );
});

test('does not call the model for an empty group', async () => {
  const { calls, fetchImpl } = recorder([]);
  assert.deepEqual(await embedTexts([], { openAiEndpoint: 'https://ai.example', token: 'token', fetchImpl }), []);
  assert.equal(calls.length, 0);
});

test('treats per-document rejections inside a 200 as a failure', async () => {
  // Search reports document errors in the body, so a naive status check would
  // report a partial index as a complete one.
  const { fetchImpl } = recorder([response({
    status: 200,
    body: { value: [{ key: 'doc-1', status: true }, { key: 'doc-2', status: false, errorMessage: 'unknown field' }] }
  })]);

  await assert.rejects(
    uploadActions([{ id: 'doc-1' }, { id: 'doc-2' }], {
      searchEndpoint: 'https://search.example', token: 'token', fetchImpl, sleep: async () => {}
    }),
    /1 document\(s\) were rejected by Search. First: doc-2 unknown field/
  );
});

test('reports the number of documents actually accepted', async () => {
  const { calls, fetchImpl } = recorder([response({
    status: 200,
    body: { value: [{ key: 'doc-1', status: true }] }
  })]);

  const count = await uploadActions([{ id: 'doc-1' }], {
    searchEndpoint: 'https://search.example/', indexName: 'course-content-index', token: 'token', fetchImpl
  });

  assert.equal(count, 1);
  assert.match(calls[0].url, /\/indexes\/course-content-index\/docs\/index\?api-version=/);
  assert.ok(!calls[0].url.includes('//indexes'), 'a trailing slash on the endpoint must not double up');
});
