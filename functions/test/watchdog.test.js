'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_TIMEOUTS, classifyImport, timeoutsFromEnv, watchedStatusFilter } = require('../src/watchdog');

const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-03-01T12:00:00.000Z');

function ago(minutes) {
  return new Date(NOW - minutes * MINUTE).toISOString();
}

function classify(entity, options = {}) {
  return classifyImport(entity, { now: NOW, ...options });
}

test('leaves a healthy in-flight import alone', () => {
  for (const status of ['uploaded', 'queued', 'extracting']) {
    const decision = classify({ status, updatedAt: ago(1), createdAt: ago(2) });
    assert.equal(decision.action, 'ignore', `a fresh '${status}' import must not be touched`);
  }
});

test('never touches a status it does not own', () => {
  for (const status of ['complete', 'failed-validation', 'failed-processing', 'cancelled', 'upload-expired', undefined]) {
    const decision = classify({ status, updatedAt: ago(600), createdAt: ago(600) });
    assert.equal(decision.action, 'ignore', `status '${status}' must be left alone`);
  }
});

test('retires an upload only after its access window has closed', () => {
  const open = classify({ status: 'uploading', createdAt: ago(300), updatedAt: ago(300), expiresAt: ago(-10) });
  assert.equal(open.action, 'ignore', 'an upload whose SAS is still valid must keep running');

  const withinGrace = classify({ status: 'uploading', createdAt: ago(300), updatedAt: ago(300), expiresAt: ago(5) });
  assert.equal(withinGrace.action, 'ignore', 'the grace period must cover a final block commit');

  const expired = classify({ status: 'uploading', createdAt: ago(300), updatedAt: ago(300), expiresAt: ago(60) });
  assert.equal(expired.action, 'fail');
  assert.equal(expired.status, 'upload-expired');
  assert.match(expired.message, /access window/);
});

test('falls back to the upload window when a record predates the stored expiry', () => {
  const fresh = classify({ status: 'uploading', createdAt: ago(30), updatedAt: ago(30) });
  assert.equal(fresh.action, 'ignore');

  const stale = classify({ status: 'uploading', createdAt: ago(400), updatedAt: ago(400) });
  assert.equal(stale.action, 'fail');
  assert.equal(stale.status, 'upload-expired');
});

test('an upload is never retried, because the browser that held the SAS is gone', () => {
  const decision = classify({ status: 'uploading', createdAt: ago(400), updatedAt: ago(400), extractionAttempts: 0 });
  assert.equal(decision.action, 'fail');
});

test('restarts a stalled import and fails it once the attempts are spent', () => {
  const stalled = { status: 'extracting', createdAt: ago(200), updatedAt: ago(120) };

  const first = classify(stalled);
  assert.equal(first.action, 'retry');
  assert.equal(first.attempt, 1);

  const second = classify({ ...stalled, extractionAttempts: 2 });
  assert.equal(second.action, 'retry');
  assert.equal(second.attempt, 3);

  const exhausted = classify({ ...stalled, extractionAttempts: 3 });
  assert.equal(exhausted.action, 'fail');
  assert.equal(exhausted.status, 'failed-processing');
  assert.doesNotMatch(exhausted.message, /stalled|attempt/, 'the professor must not see internal detail');
});

test('a heartbeat keeps a long extraction alive past the stall threshold', () => {
  const beating = classify({
    status: 'extracting',
    createdAt: ago(600),
    updatedAt: ago(600),
    heartbeatAt: ago(1)
  });
  assert.equal(beating.action, 'ignore', 'a worker that is still beating must never be restarted');

  const silent = classify({
    status: 'extracting',
    createdAt: ago(600),
    updatedAt: ago(600),
    heartbeatAt: ago(90)
  });
  assert.equal(silent.action, 'retry', 'a worker that stopped beating is gone');
});

test('recovers an import stuck waiting for a blob event', () => {
  const decision = classify({ status: 'uploaded', createdAt: ago(60), updatedAt: ago(30) });
  assert.equal(decision.action, 'retry', 'a lost Event Grid delivery must not strand the import');
});

test('finishes a cancellation whose worker never came back', () => {
  const stopping = classify({ status: 'extracting', updatedAt: ago(2), createdAt: ago(10), cancellationRequested: true });
  assert.equal(stopping.action, 'ignore', 'a live worker gets to stop at its own checkpoint');

  const abandoned = classify({ status: 'extracting', updatedAt: ago(60), createdAt: ago(90), cancellationRequested: true });
  assert.equal(abandoned.action, 'fail');
  assert.equal(abandoned.status, 'cancelled');
});

test('a cancelled import is never restarted, however long it has stalled', () => {
  const decision = classify({
    status: 'queued',
    updatedAt: ago(600),
    createdAt: ago(600),
    cancellationRequested: true
  });
  assert.equal(decision.action, 'fail');
  assert.equal(decision.status, 'cancelled');
});

test('sweeping indexing is disabled until a phase owns it', () => {
  const entity = { status: 'indexing', createdAt: ago(6000), updatedAt: ago(6000) };
  assert.equal(DEFAULT_TIMEOUTS.indexingMs, 0);
  assert.equal(classify(entity).action, 'ignore', 'a successful extraction must not be failed by the sweep');

  const enabled = classify(entity, { timeouts: { indexingMs: 30 * MINUTE } });
  assert.equal(enabled.action, 'fail');
  assert.equal(enabled.status, 'failed-processing');
});

test('ignores a record with no usable timestamp rather than guessing', () => {
  assert.equal(classify({ status: 'queued' }).action, 'ignore');
  assert.equal(classify({ status: 'queued', updatedAt: 'not-a-date' }).action, 'ignore');
});

test('reads threshold overrides from the environment and ignores unusable ones', () => {
  const timeouts = timeoutsFromEnv({
    WATCHDOG_EXTRACTING_MINUTES: '180',
    WATCHDOG_QUEUED_MINUTES: '',
    WATCHDOG_UPLOADED_MINUTES: 'soon'
  });
  assert.equal(timeouts.extractingMs, 180 * MINUTE);
  assert.equal('queuedMs' in timeouts, false, 'a blank override must fall back to the default');
  assert.equal('uploadedMs' in timeouts, false, 'an unparseable override must fall back to the default');
});

test('queries only the statuses the watchdog is allowed to act on', () => {
  const filter = watchedStatusFilter();
  for (const status of ['uploading', 'uploaded', 'queued', 'extracting', 'indexing']) {
    assert.ok(filter.includes(`status eq '${status}'`), `'${status}' must be swept`);
  }
  assert.ok(!filter.includes("'complete'"), 'finished imports must not even be read');
  assert.ok(!filter.includes("'cancelled'"));
});
