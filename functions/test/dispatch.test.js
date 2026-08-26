'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { importFromEvent } = require('../src/dispatch');

const partitionKey = 'a'.repeat(64);
const importId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const blobName = `${partitionKey}/${importId}/course.imscc`;

function blobCreated(overrides = {}, dataOverrides = {}) {
  return {
    eventType: 'Microsoft.Storage.BlobCreated',
    subject: `/blobServices/default/containers/raw-imscc/blobs/${blobName}`,
    data: {
      api: 'PutBlockList',
      url: `https://acct.blob.core.windows.net/raw-imscc/${blobName}`,
      contentLength: 5368709120,
      ...dataOverrides
    },
    ...overrides
  };
}

test('identifies the import behind a committed blob event', () => {
  assert.deepEqual(importFromEvent(blobCreated()), {
    partitionKey,
    importId,
    blobName,
    contentLength: 5368709120
  });
});

test('accepts the CloudEvents schema and falls back to the blob url', () => {
  const cloudEvent = { type: 'Microsoft.Storage.BlobCreated', data: blobCreated().data };
  assert.equal(importFromEvent(cloudEvent).importId, importId);
});

test('ignores a block upload that has not been committed yet', () => {
  // Every 16 MB block raises PutBlock; only the committed block list means the
  // archive is complete.
  assert.match(importFromEvent(blobCreated({}, { api: 'PutBlock' })).error, /not committed yet/);
});

test('ignores events that are not a committed blob in the raw container', () => {
  const cases = [
    blobCreated({ eventType: 'Microsoft.Storage.BlobDeleted' }),
    blobCreated({ subject: '/blobServices/default/containers/policies/blobs/prof.json', data: {} }),
    undefined,
    null,
    'not an event',
    {}
  ];
  for (const event of cases) assert.ok(importFromEvent(event).error, `${JSON.stringify(event)} must be ignored`);
});

test('refuses blob paths that do not match the layout the portal generates', () => {
  const paths = [
    `${partitionKey}/${importId}/other.imscc`,
    `${partitionKey}/not-a-uuid/course.imscc`,
    `short-partition/${importId}/course.imscc`,
    `${partitionKey}/${importId}/nested/course.imscc`,
    `${importId}/course.imscc`
  ];
  for (const path of paths) {
    const event = blobCreated({ subject: `/blobServices/default/containers/raw-imscc/blobs/${path}` }, { url: '' });
    assert.ok(importFromEvent(event).error, `${path} must be refused`);
  }
});

test('honours a container name other than the default', () => {
  const event = blobCreated({ subject: `/blobServices/default/containers/other-raw/blobs/${blobName}` }, { url: '' });
  assert.ok(importFromEvent(event).error);
  assert.equal(importFromEvent(event, { container: 'other-raw' }).importId, importId);
});
