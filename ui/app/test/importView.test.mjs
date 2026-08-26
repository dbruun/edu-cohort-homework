import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAST_POLL_MS,
  POLL_FAILURES_BEFORE_WARNING,
  SLOW_POLL_MS,
  canCancel,
  documentsLabel,
  failureGuidance,
  finishedLabel,
  formatBytes,
  formatElapsed,
  historyDetail,
  importSize,
  importSubtitle,
  importTitle,
  isInterruptedUpload,
  isTerminal,
  lastUpdatedLabel,
  mergeImports,
  partitionImports,
  pollDelayForRecords,
  pollDelayMs,
  pollFailureWarning,
  processingProgress,
  stageDetail,
  stageOf
} from '../src/importView.mjs';

test('maps every pipeline state onto a stage a professor understands', () => {
  assert.equal(stageOf('uploading'), 'uploading');
  for (const status of ['uploaded', 'queued', 'extracting', 'indexing']) {
    assert.equal(stageOf(status), 'processing', `${status} is work in progress`);
  }
  assert.equal(stageOf('complete'), 'ready');
  for (const status of ['cancelled', 'failed-validation', 'failed-processing', 'failed-indexing', 'upload-expired']) {
    assert.equal(stageOf(status), 'attention', `${status} needs the professor`);
  }
});

test('treats an unrecognised state as needing attention rather than as success', () => {
  // A pipeline that gains a state the portal has not been taught must not
  // report that state as finished content.
  assert.equal(stageOf('some-future-state'), 'attention');
  assert.notEqual(stageOf('some-future-state'), 'ready');
});

test('stops polling exactly on the states that can no longer change', () => {
  for (const status of ['complete', 'cancelled', 'failed-validation', 'failed-processing', 'failed-indexing', 'upload-expired']) {
    assert.equal(isTerminal(status), true, status);
  }
  for (const status of ['uploading', 'uploaded', 'queued', 'extracting', 'indexing']) {
    assert.equal(isTerminal(status), false, status);
  }
});

test('every failure says what to do and that existing content survived', () => {
  for (const status of ['failed-validation', 'failed-processing', 'failed-indexing', 'upload-expired', 'cancelled']) {
    const guidance = failureGuidance(status);
    assert.ok(guidance.message.length > 0, `${status} needs a message`);
    assert.ok(guidance.action.length > 0, `${status} needs a recommended action`);
    assert.equal(guidance.contentUnchanged, true, `${status} must reassure about existing content`);
  }
  // An unknown failure still has to offer a way forward.
  assert.ok(failureGuidance('who-knows').action.length > 0);
});

test('shows no processing percentage until extraction has counted the documents', () => {
  const unknown = processingProgress({ documentsDiscovered: 0, documentsIndexed: 0 });
  assert.equal(unknown.known, false);
  assert.equal(unknown.percent, null, 'a fabricated percentage misrepresents the work');

  const known = processingProgress({ documentsDiscovered: 8, documentsIndexed: 2 });
  assert.deepEqual(known, { known: true, indexed: 2, discovered: 8, percent: 25 });
});

test('never reports more than complete progress', () => {
  const progress = processingProgress({ documentsDiscovered: 4, documentsIndexed: 9 });
  assert.equal(progress.percent, 100);
});

test('polls often while an import is young and backs off afterwards', () => {
  assert.equal(pollDelayMs(0), FAST_POLL_MS);
  assert.equal(pollDelayMs(119_000), FAST_POLL_MS);
  assert.equal(pollDelayMs(120_000), SLOW_POLL_MS);
  assert.equal(pollDelayMs(10 * 60 * 1000), SLOW_POLL_MS);
});

test('treats a failed status request as transient before warning', () => {
  for (let failures = 0; failures < POLL_FAILURES_BEFORE_WARNING; failures += 1) {
    assert.equal(pollFailureWarning(failures), '', `${failures} failures is not yet an outage`);
  }
  const warning = pollFailureWarning(POLL_FAILURES_BEFORE_WARNING);
  assert.ok(warning.length > 0);
  // The import is still running; the portal has only lost sight of it.
  assert.match(warning, /still running/i);
});

test('titles a card by filename until the course name is known', () => {
  assert.equal(importTitle({ originalFileName: 'export.imscc' }), 'export.imscc');
  assert.equal(importSubtitle({ originalFileName: 'export.imscc' }), '');

  const extracted = { originalFileName: 'export.imscc', courseName: 'Biology 101' };
  assert.equal(importTitle(extracted), 'Biology 101');
  assert.equal(importSubtitle(extracted), 'export.imscc', 'the filename stays available as secondary detail');
});

test('describes a finished import by what the tutor can now use', () => {
  assert.match(stageDetail({ status: 'complete', documentsIndexed: 1 }), /^1 document /);
  assert.match(stageDetail({ status: 'complete', documentsIndexed: 12 }), /^12 documents /);
  assert.match(stageDetail({ status: 'extracting' }), /Reading the course package/);
  assert.match(stageDetail({ status: 'failed-validation' }), /could not be read/);
});

test('marks an upload the browser is no longer running as interrupted', () => {
  const record = { importId: 'a', status: 'uploading' };
  assert.equal(isInterruptedUpload(record, new Set(['a'])), false, 'this page is still uploading it');
  assert.equal(isInterruptedUpload(record, new Set()), true, 'no browser holds the file any more');
  assert.equal(isInterruptedUpload({ importId: 'a', status: 'extracting' }, new Set()), false);
});

test('offers cancel for anything still running and withholds it once finished', () => {
  assert.equal(canCancel({ status: 'extracting' }), true);
  assert.equal(canCancel({ status: 'uploading' }), true);
  assert.equal(canCancel({ status: 'complete' }), false);
  assert.equal(canCancel({ status: 'cancelled' }), false);
});

test('formats sizes and elapsed time without misleading precision', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(50 * 1024 * 1024), '50 MB');
  assert.equal(formatBytes(-1), '');
  assert.equal(formatBytes('not a number'), '');

  const now = Date.parse('2026-01-01T00:10:00Z');
  assert.equal(formatElapsed('2026-01-01T00:09:30Z', now), '30s');
  assert.equal(formatElapsed('2026-01-01T00:08:00Z', now), '2m 0s');
  assert.equal(formatElapsed('2025-12-31T22:40:00Z', now), '1h 30m');
  assert.equal(formatElapsed('nonsense', now), '');
});

test('surfaces how long ago an import last moved', () => {
  const now = Date.parse('2026-01-01T00:10:00Z');
  assert.equal(lastUpdatedLabel({ updatedAt: '2026-01-01T00:08:00Z' }, now), 'Updated 2m 0s ago');
  assert.equal(lastUpdatedLabel({}, now), '');
});

test('follows the youngest running import when choosing a poll cadence', () => {
  const now = Date.parse('2026-01-01T01:00:00Z');
  const old = { importId: 'old', status: 'extracting', createdAt: '2026-01-01T00:00:00Z' };
  const fresh = { importId: 'fresh', status: 'uploading', createdAt: '2026-01-01T00:59:55Z' };

  assert.equal(pollDelayForRecords([old], now), SLOW_POLL_MS);
  // A page left open for an hour must still poll quickly for a new import.
  assert.equal(pollDelayForRecords([old, fresh], now), FAST_POLL_MS);
});

test('ignores finished imports when choosing a poll cadence', () => {
  const now = Date.parse('2026-01-01T01:00:00Z');
  const justFinished = { importId: 'done', status: 'complete', createdAt: '2026-01-01T00:59:59Z' };
  assert.equal(pollDelayForRecords([justFinished], now), SLOW_POLL_MS);
});

test('merging keeps an import that has not been polled yet', () => {
  const local = [{ importId: 'new-upload', status: 'uploading' }];
  const merged = mergeImports(local, [{ importId: 'other', status: 'complete' }]);

  assert.equal(merged.length, 2, 'a just-started upload must not vanish from the view');
  assert.ok(merged.some((record) => record.importId === 'new-upload'));
});

test('merging updates a record in place rather than duplicating it', () => {
  const merged = mergeImports(
    [{ importId: 'a', status: 'queued', originalFileName: 'export.imscc' }],
    [{ importId: 'a', status: 'extracting' }]
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'extracting');
  // Fields the status response does not repeat must survive the merge.
  assert.equal(merged[0].originalFileName, 'export.imscc');
});

test('merging ignores a response that carries no import id', () => {
  const merged = mergeImports([{ importId: 'a', status: 'queued' }], [null, {}, undefined]);
  assert.deepEqual(merged, [{ importId: 'a', status: 'queued' }]);
});

test('separates running imports from finished ones', () => {
  const { active, history } = partitionImports([
    { importId: 'a', status: 'extracting', createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T10:05:00Z' },
    { importId: 'b', status: 'complete', createdAt: '2026-01-01T09:00:00Z', updatedAt: '2026-01-01T09:30:00Z' },
    { importId: 'c', status: 'uploading', createdAt: '2026-01-01T11:00:00Z', updatedAt: '2026-01-01T11:00:00Z' },
    { importId: 'd', status: 'failed-validation', createdAt: '2026-01-01T08:00:00Z', updatedAt: '2026-01-01T08:10:00Z' }
  ]);

  assert.deepEqual(active.map((record) => record.importId), ['c', 'a'], 'newest running import first');
  assert.deepEqual(history.map((record) => record.importId), ['b', 'd'], 'most recently finished first');
});

test('keeps every concurrent import visible rather than showing only the newest', () => {
  // A professor can start a second import while the first is still running, and
  // neither may be dropped from the view.
  const { active } = partitionImports([
    { importId: 'a', status: 'indexing', createdAt: '2026-01-01T10:00:00Z' },
    { importId: 'b', status: 'uploading', createdAt: '2026-01-01T10:01:00Z' }
  ]);

  assert.equal(active.length, 2);
});

test('sorts a record with an unusable timestamp last instead of to the top', () => {
  const { history } = partitionImports([
    { importId: 'undated', status: 'complete' },
    { importId: 'dated', status: 'complete', updatedAt: '2026-01-01T09:00:00Z' }
  ]);

  assert.deepEqual(history.map((record) => record.importId), ['dated', 'undated']);
});

test('partitions an empty or missing list without failing', () => {
  assert.deepEqual(partitionImports([]), { active: [], history: [] });
  assert.deepEqual(partitionImports(undefined), { active: [], history: [] });
});

test('reports a document count only for an import that finished', () => {
  assert.equal(documentsLabel({ status: 'complete', documentsIndexed: 9 }), '9');
  assert.equal(documentsLabel({ status: 'complete', documentsIndexed: 0 }), '0');
  // A failure that indexed some documents published none of them, so reporting a
  // count would suggest the tutor gained content it did not gain.
  assert.equal(documentsLabel({ status: 'failed-indexing', documentsIndexed: 4 }), '-');
  assert.equal(documentsLabel({ status: 'cancelled', documentsIndexed: 2 }), '-');
});

test('sizes an import by the file chosen, not by how much of it arrived', () => {
  // An upload that stopped half way is still an import of the whole file.
  assert.equal(importSize({ expectedBytes: 2 * 1024 * 1024, uploadedBytes: 1024 }), '2.0 MB');
  assert.equal(importSize({}), '-');
});

test('keeps the full failure guidance available to a history row', () => {
  const detail = historyDetail({ importId: 'ref-1', status: 'failed-validation' });

  assert.equal(detail.message, failureGuidance('failed-validation').message);
  assert.equal(detail.action, failureGuidance('failed-validation').action);
  assert.equal(detail.contentUnchanged, true, 'the professor is told their published content is intact');
  assert.equal(detail.reference, 'ref-1', 'support needs the reference on the failure, not on every row');
});

test('gives a successful row no failure detail', () => {
  assert.equal(historyDetail({ importId: 'ref-2', status: 'complete' }), null);
});

test('explains an unrecognised final state rather than leaving the row bare', () => {
  const detail = historyDetail({ importId: 'ref-3', status: 'some-future-state' });
  assert.ok(detail && detail.action, 'an unknown state still tells the professor what to do');
});

test('dates a finished import by when it stopped', () => {
  const now = Date.parse('2026-01-01T10:05:00Z');
  assert.equal(finishedLabel({ updatedAt: '2026-01-01T10:00:00Z' }, now), '5m 0s ago');
  assert.equal(finishedLabel({}, now), '-');
});
