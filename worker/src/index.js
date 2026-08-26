'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TableClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');
const { BlobServiceClient } = require('@azure/storage-blob');
const { extractCourseContent } = require('./extract');
const { ImportState, canExtract } = require('./state');
const {
  batchWriter,
  downloadArchive,
  writeCompletionManifest,
  writeFailureReport
} = require('./storage');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function failureStatus(error) {
  if (error.cancelled) return 'cancelled';
  return error.validation ? 'failed-validation' : 'failed-processing';
}

async function run() {
  const accountName = required('STORAGE_ACCOUNT');
  const importId = required('IMPORT_ID');
  const partitionKey = required('IMPORT_PARTITION_KEY');
  const rawContainer = process.env.RAW_IMSCC_CONTAINER || 'raw-imscc';
  const processedContainer = process.env.PROCESSED_CONTAINER || 'processed-course-content';
  const failedContainer = process.env.FAILED_CONTAINER || 'failed-imports';

  const credential = new DefaultAzureCredential();
  const blobService = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential);
  const table = new TableClient(
    `https://${accountName}.table.core.windows.net`,
    process.env.IMSCC_IMPORT_TABLE || 'ImsccImports',
    credential
  );
  const state = new ImportState(table, partitionKey, importId);
  const entity = await state.read();

  // A duplicate blob event or a retried job must not reprocess an import that
  // already moved on.
  if (!canExtract(entity)) {
    console.log(`[extract] Import ${importId} is '${entity.status}' and does not need extraction.`);
    return;
  }
  if (entity.cancellationRequested === true) {
    await state.merge({ status: 'cancelled' });
    console.log(`[extract] Import ${importId} was cancelled before extraction started.`);
    return;
  }

  await state.merge({ status: 'extracting' });

  const workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'imscc-'));
  const archivePath = path.join(workDirectory, 'course.imscc');
  try {
    const rawBlob = blobService.getContainerClient(rawContainer).getBlockBlobClient(entity.blobName);
    const { archiveSha256, bytes } = await downloadArchive(rawBlob, archivePath);
    console.log(`[extract] Import ${importId} downloaded ${bytes} bytes.`);

    const processed = blobService.getContainerClient(processedContainer);
    const manifest = await extractCourseContent({
      archivePath,
      professorId: entity.professorId,
      importId,
      archiveSha256,
      writeBatch: batchWriter(processed, importId),
      isCancelled: state.cancellationChecker()
    });
    await writeCompletionManifest(processed, importId, manifest);

    await state.merge({
      status: 'indexing',
      courseName: manifest.courseName,
      courseNameSource: manifest.courseNameSource,
      cartridgeIdentifier: manifest.cartridgeIdentifier,
      archiveSha256,
      uploadedBytes: bytes,
      documentsDiscovered: manifest.chunksProduced,
      batchCount: manifest.batches.length,
      warningCount: manifest.warnings.length,
      error: ''
    });
    console.log(`[extract] Import ${importId} produced ${manifest.chunksProduced} chunk(s) in ${manifest.batches.length} batch(es).`);
  } catch (error) {
    const status = failureStatus(error);
    console.error(`[extract] Import ${importId} ended as '${status}'.`, error);
    try {
      await writeFailureReport(blobService.getContainerClient(failedContainer), importId, {
        importId,
        status,
        blobName: entity.blobName,
        security: error.security === true,
        message: error.message,
        failedAt: new Date().toISOString()
      });
    } catch (reportError) {
      console.error(`[extract] Could not write the failure report for ${importId}.`, reportError);
    }
    // Only a safe summary reaches the professor; the detail stays in telemetry.
    await state.merge({
      status,
      error: error.validation
        ? error.message
        : 'The course export could not be processed. Try the import again.'
    });
    if (!error.validation && !error.cancelled) throw error;
  } finally {
    await fs.rm(workDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error('[extract] The extraction job failed.', error);
    process.exitCode = 1;
  });
}

module.exports = { failureStatus, run };
