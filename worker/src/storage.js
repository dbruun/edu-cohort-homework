'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');

// The archive is streamed to local disk and hashed on the way past, so a
// multi-gigabyte import never has to fit in memory and the checksum costs no
// extra read.
async function downloadArchive(blobClient, destinationPath) {
  const download = await blobClient.download();
  const hash = crypto.createHash('sha256');
  let bytes = 0;

  await pipeline(
    download.readableStreamBody,
    async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk);
        bytes += chunk.length;
        yield chunk;
      }
    },
    fs.createWriteStream(destinationPath)
  );

  return { archiveSha256: hash.digest('hex'), bytes };
}

function processedPrefix(importId) {
  return `${importId}/`;
}

async function uploadText(containerClient, blobName, body, contentType) {
  const blob = containerClient.getBlockBlobClient(blobName);
  await blob.upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: { blobContentType: contentType }
  });
}

function batchWriter(containerClient, importId) {
  return (name, body) => uploadText(
    containerClient,
    `${processedPrefix(importId)}${name}`,
    body,
    'application/x-ndjson'
  );
}

function writeCompletionManifest(containerClient, importId, manifest) {
  return uploadText(
    containerClient,
    `${processedPrefix(importId)}completion.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'application/json'
  );
}

// The raw archive is left where it is rather than copied: a rejected import can
// be multiple gigabytes, and the lifecycle policy already expires it. The
// report is what an operator needs to investigate.
function writeFailureReport(containerClient, importId, report) {
  return uploadText(
    containerClient,
    `${importId}/failure.json`,
    `${JSON.stringify(report, null, 2)}\n`,
    'application/json'
  );
}

module.exports = {
  batchWriter,
  downloadArchive,
  processedPrefix,
  uploadText,
  writeCompletionManifest,
  writeFailureReport
};
