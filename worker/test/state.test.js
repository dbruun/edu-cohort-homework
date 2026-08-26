'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ImportState, canExtract } = require('../src/state');

function fakeTable(entity) {
  const merges = [];
  return {
    merges,
    async getEntity() {
      if (!entity) throw Object.assign(new Error('Not found'), { statusCode: 404 });
      return { ...entity };
    },
    async updateEntity(patch, mode) {
      merges.push({ patch, mode });
      entity = { ...entity, ...patch };
    }
  };
}

test('only extracts an import that is actually waiting for extraction', () => {
  for (const status of ['uploaded', 'queued', 'extracting']) {
    assert.equal(canExtract({ status }), true, `${status} must be extractable`);
  }
  // A duplicate blob event or a retried job must not redo finished work.
  for (const status of ['uploading', 'indexing', 'complete', 'cancelled', 'failed-validation', undefined]) {
    assert.equal(canExtract({ status }), false, `${status} must not be re-extracted`);
  }
});

test('merges state so concurrent stages cannot erase each other', async () => {
  const table = fakeTable({ partitionKey: 'p', rowKey: 'i', status: 'uploaded' });
  await new ImportState(table, 'p', 'i').merge({ status: 'extracting' });

  const [{ patch, mode }] = table.merges;
  assert.equal(mode, 'Merge');
  assert.equal(patch.status, 'extracting');
  assert.equal(patch.partitionKey, 'p');
  assert.equal(patch.rowKey, 'i');
  assert.ok(patch.updatedAt instanceof Date);
});

test('treats a requested cancellation and a cancelled import alike', async () => {
  assert.equal(await new ImportState(fakeTable({ status: 'extracting', cancellationRequested: true }), 'p', 'i').isCancelled(), true);
  assert.equal(await new ImportState(fakeTable({ status: 'cancelled' }), 'p', 'i').isCancelled(), true);
  assert.equal(await new ImportState(fakeTable({ status: 'extracting' }), 'p', 'i').isCancelled(), false);
});

test('keeps working when the state store is briefly unavailable', async () => {
  const failing = { async getEntity() { throw new Error('table unavailable'); } };
  assert.equal(await new ImportState(failing, 'p', 'i').isCancelled(), false);
});

test('caches the cancellation answer instead of reading once per member', async () => {
  let reads = 0;
  const table = {
    async getEntity() {
      reads += 1;
      return { status: 'extracting' };
    }
  };
  const isCancelled = new ImportState(table, 'p', 'i').cancellationChecker(60000);

  for (let attempt = 0; attempt < 500; attempt += 1) assert.equal(await isCancelled(), false);
  assert.equal(reads, 1, 'a large archive must not generate one state read per member');
});

test('stops asking once cancellation is observed', async () => {
  let reads = 0;
  const table = {
    async getEntity() {
      reads += 1;
      return { status: 'cancelled' };
    }
  };
  const isCancelled = new ImportState(table, 'p', 'i').cancellationChecker(0);

  assert.equal(await isCancelled(), true);
  assert.equal(await isCancelled(), true);
  assert.equal(reads, 1);
});

test('beats a heartbeat while extracting, so a long run is not mistaken for a dead one', async () => {
  const table = fakeTable({ status: 'extracting' });
  const state = new ImportState(table, 'p', 'i');
  // Reading often is cheap; writing a heartbeat is throttled independently.
  const checker = state.cancellationChecker(0, 20);

  assert.equal(await checker(), false);
  assert.equal(table.merges.length, 0, 'the first check must not write immediately');

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await checker(), false);

  const beats = table.merges.filter((merge) => merge.patch.heartbeatAt instanceof Date);
  assert.equal(beats.length, 1, 'a live worker must record exactly one beat per interval');
  assert.equal(beats[0].mode, 'Merge', 'the beat must not erase fields written by another stage');
});

test('a failed heartbeat never interrupts healthy extraction', async () => {
  const table = fakeTable({ status: 'extracting' });
  table.updateEntity = async () => { throw new Error('Table is unavailable'); };
  const state = new ImportState(table, 'p', 'i');
  const checker = state.cancellationChecker(0, 0);

  assert.equal(await checker(), false, 'losing a beat must not stop the work');
});

test('a cancelled worker stops rather than announcing it is alive', async () => {
  const table = fakeTable({ status: 'extracting', cancellationRequested: true });
  const state = new ImportState(table, 'p', 'i');
  const checker = state.cancellationChecker(0, 0);

  assert.equal(await checker(), true);
  assert.equal(table.merges.length, 0, 'a worker that is stopping must not extend the watchdog window');
});
