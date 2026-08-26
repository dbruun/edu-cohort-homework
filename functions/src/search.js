'use strict';

const { DefaultAzureCredential } = require('@azure/identity');

const OPENAI_SCOPE = 'https://cognitiveservices.azure.com/.default';
const SEARCH_SCOPE = 'https://search.azure.com/.default';
const EMBEDDING_API_VERSION = '2024-10-21';
const SEARCH_API_VERSION = '2026-04-01';
const EMBEDDING_DIMENSIONS = 1536;
// Embedding requests are billed and rate limited per request, so inputs are
// grouped; Search rejects oversized payloads, so uploads are grouped too.
const DEFAULT_EMBEDDING_GROUP = 16;
const DEFAULT_UPLOAD_GROUP = 100;
const DEFAULT_MAX_ATTEMPTS = 5;

let cachedCredential;
function credential() {
  if (!cachedCredential) cachedCredential = new DefaultAzureCredential();
  return cachedCredential;
}

function retryable(status) {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelayMs(response, attempt, baseDelayMs) {
  // The service knows better than any local guess how long to wait, so an
  // explicit Retry-After always wins.
  const header = response && response.headers && response.headers.get('retry-after');
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return baseDelayMs * 2 ** (attempt - 1);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Throttling is the expected steady state at import scale, not an exception, so
// it is retried here rather than by failing the whole import back to the queue.
async function requestWithRetry(url, options, {
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = 1000,
  sleep = wait,
  fetchImpl = fetch,
  label = 'request'
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, options);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
      continue;
    }
    if (response.ok) return response;

    const detail = await response.text().catch(() => '');
    lastError = new Error(`The ${label} failed with HTTP ${response.status}. ${detail.slice(0, 300)}`.trim());
    // A rejected payload will be rejected identically forever, so only
    // transient statuses are worth another attempt.
    if (!retryable(response.status) || attempt === maxAttempts) {
      lastError.permanent = !retryable(response.status);
      throw lastError;
    }
    await sleep(retryDelayMs(response, attempt, baseDelayMs));
  }
  throw lastError;
}

async function embedTexts(texts, {
  openAiEndpoint = process.env.OPENAI_ENDPOINT,
  deployment = process.env.EMBEDDING_DEPLOYMENT || 'text-embedding-3-small',
  dimensions = EMBEDDING_DIMENSIONS,
  token,
  ...retryOptions
} = {}) {
  if (!openAiEndpoint) throw new Error('OPENAI_ENDPOINT is required.');
  if (!texts.length) return [];

  const accessToken = token || (await credential().getToken(OPENAI_SCOPE)).token;
  const url = `${openAiEndpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(deployment)}` +
    `/embeddings?api-version=${EMBEDDING_API_VERSION}`;

  const response = await requestWithRetry(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input: texts, dimensions })
  }, { ...retryOptions, label: 'embedding request' });

  const payload = await response.json();
  const data = [...(payload.data || [])].sort((left, right) => left.index - right.index);
  // A short or reordered response would silently pair text with the wrong
  // vector, which is worse than failing the batch.
  if (data.length !== texts.length) {
    throw new Error(`The embedding response returned ${data.length} vectors for ${texts.length} inputs.`);
  }
  return data.map((item) => item.embedding);
}

async function uploadActions(actions, {
  searchEndpoint = process.env.SEARCH_ENDPOINT,
  indexName = process.env.SEARCH_INDEX_NAME || 'course-content-index',
  token,
  ...retryOptions
} = {}) {
  if (!searchEndpoint) throw new Error('SEARCH_ENDPOINT is required.');
  if (!actions.length) return 0;

  const accessToken = token || (await credential().getToken(SEARCH_SCOPE)).token;
  const url = `${searchEndpoint.replace(/\/$/, '')}/indexes/${encodeURIComponent(indexName)}` +
    `/docs/index?api-version=${SEARCH_API_VERSION}`;

  const response = await requestWithRetry(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ value: actions })
  }, { ...retryOptions, label: `Search upload to index '${indexName}'` });

  // Search reports per-document failures inside a 200 response, so the body has
  // to be inspected or a partial index would look like a success.
  const payload = await response.json().catch(() => ({}));
  const failed = (payload.value || []).filter((result) => result.status === false);
  if (failed.length) {
    const first = failed[0];
    throw new Error(`${failed.length} document(s) were rejected by Search. First: ${first.key} ${first.errorMessage || ''}`.trim());
  }
  return actions.length;
}

module.exports = {
  DEFAULT_EMBEDDING_GROUP,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_UPLOAD_GROUP,
  EMBEDDING_DIMENSIONS,
  SEARCH_API_VERSION,
  embedTexts,
  requestWithRetry,
  retryDelayMs,
  retryable,
  uploadActions
};
