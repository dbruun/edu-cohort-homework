'use strict';

// Event Grid delivers blob events to Service Bus in either the Event Grid or
// the CloudEvents schema, and a queue can also receive replays and unrelated
// events. Everything the dispatcher trusts is derived here, from the event
// itself, and never from the message metadata.

const BLOB_CREATED = 'Microsoft.Storage.BlobCreated';
// Only these APIs mean the blob is complete. A block upload raises PutBlockList
// when the block list is committed; PutBlock does not.
const COMMIT_APIS = new Set(['PutBlockList', 'PutBlob', 'CopyBlob', 'FlushWithClose']);
const PARTITION_PATTERN = /^[0-9a-f]{64}$/i;
const IMPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARCHIVE_NAME = 'course.imscc';

function eventType(event) {
  return event?.eventType || event?.type || '';
}

function blobPathFromSubject(subject, container) {
  const marker = `/containers/${container}/blobs/`;
  const index = typeof subject === 'string' ? subject.indexOf(marker) : -1;
  return index === -1 ? '' : subject.slice(index + marker.length);
}

function blobPathFromUrl(url, container) {
  if (typeof url !== 'string') return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  const prefix = `/${container}/`;
  return parsed.pathname.startsWith(prefix) ? decodeURIComponent(parsed.pathname.slice(prefix.length)) : '';
}

function importFromEvent(event, { container = 'raw-imscc' } = {}) {
  if (!event || typeof event !== 'object') return { error: 'the message is not an event' };
  if (eventType(event) !== BLOB_CREATED) return { error: `unrelated event type '${eventType(event)}'` };

  const data = event.data || {};
  if (data.api && !COMMIT_APIS.has(data.api)) {
    return { error: `the blob is not committed yet (${data.api})` };
  }

  const blobName = blobPathFromSubject(event.subject, container) || blobPathFromUrl(data.url, container);
  if (!blobName) return { error: 'the event does not name a blob in the raw container' };

  const segments = blobName.split('/');
  if (segments.length !== 3 || segments[2] !== ARCHIVE_NAME) {
    return { error: `unexpected blob path '${blobName}'` };
  }
  const [partitionKey, importId] = segments;
  // The path is the only thing tying a blob to an import, so it must match the
  // shape the portal generates exactly.
  if (!PARTITION_PATTERN.test(partitionKey)) return { error: 'the blob path has no valid partition key' };
  if (!IMPORT_ID_PATTERN.test(importId)) return { error: 'the blob path has no valid import id' };

  return {
    partitionKey,
    importId,
    blobName,
    contentLength: Number(data.contentLength) || 0
  };
}

module.exports = { ARCHIVE_NAME, COMMIT_APIS, blobPathFromSubject, blobPathFromUrl, importFromEvent };
