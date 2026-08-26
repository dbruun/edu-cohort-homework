'use strict';

const path = require('node:path');
const { openArchive, readMember, validationError } = require('./archive');
const { buildDocuments } = require('./documents');
const { classifyReference } = require('./classify');
const { parseManifest } = require('./manifest');

const PARSER_VERSION = '1.1.0';
const MANIFEST_NAME = 'imsmanifest.xml';
const DEFAULT_BATCH_SIZE = 200;
// Which members can be read, not which members belong. Classification is a
// separate decision in classify.js: conflating the two is how assignments came
// to be indexed alongside teaching material.
const TEXT_EXTENSIONS = new Set(['.htm', '.html', '.md', '.txt', '.xml']);
// A course can reference thousands of members. The counts are always complete;
// the samples exist to make a surprising count diagnosable without them
// growing without bound.
const MAX_EXCLUDED_SAMPLES = 20;

function batchName(index) {
  return `batch-${String(index).padStart(5, '0')}.ndjson`;
}

async function extractCourseContent({
  archivePath,
  professorId,
  importId,
  archiveSha256 = '',
  importedAt = new Date().toISOString(),
  batchSize = DEFAULT_BATCH_SIZE,
  limits = {},
  maxChunkCharacters,
  writeBatch,
  isCancelled = () => false
}) {
  if (typeof writeBatch !== 'function') throw new Error('writeBatch must be a function.');

  const archive = await openArchive(archivePath, limits);
  const warnings = [...archive.warnings];
  const skippedMembers = [...archive.skipped];

  const manifestEntry = archive.members.get(MANIFEST_NAME);
  if (!manifestEntry) throw validationError(`The archive does not contain ${MANIFEST_NAME}.`);
  const manifest = parseManifest((await readMember(manifestEntry, archive.limits.maxMemberBytes)).toString('utf8'));
  warnings.push(...manifest.warnings);

  const batches = [];
  let pending = [];
  let documentsProduced = 0;
  let chunksProduced = 0;
  const excludedCounts = {};
  const excludedSamples = [];

  const exclude = (reference, reason) => {
    excludedCounts[reason] = (excludedCounts[reason] || 0) + 1;
    if (excludedSamples.length < MAX_EXCLUDED_SAMPLES) {
      excludedSamples.push({ path: reference.path, resourceType: reference.resourceType || '', reason });
    }
  };

  const flush = async (limit) => {
    const take = limit === undefined ? pending.length : limit;
    if (!take || pending.length < take) return;
    const documents = pending.splice(0, take);
    const name = batchName(batches.length + 1);
    await writeBatch(name, `${documents.map((document) => JSON.stringify(document)).join('\n')}\n`);
    batches.push({ name, documents: documents.length });
  };

  for (const reference of manifest.references) {
    if (await isCancelled()) {
      throw Object.assign(new Error('The import was cancelled during extraction.'), { cancelled: true });
    }
    // Classification runs before the extension check so that an excluded
    // assessment is reported as excluded rather than disappearing into the
    // non-text count.
    const verdict = classifyReference(reference);
    if (!verdict.include) {
      exclude(reference, verdict.reason);
      continue;
    }

    const extension = path.extname(reference.path).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) {
      exclude(reference, 'not a readable text member');
      continue;
    }

    const entry = archive.members.get(reference.path);
    if (!entry) {
      skippedMembers.push({ path: reference.path, reason: 'referenced by the manifest but missing' });
      warnings.push(`Skipped '${reference.path}': referenced by the manifest but missing from the archive.`);
      continue;
    }

    const raw = (await readMember(entry, archive.limits.maxMemberBytes)).toString('utf8');
    const documents = buildDocuments({
      professorId,
      importId,
      courseName: manifest.courseName,
      sourcePath: reference.path,
      resourceIdentifier: reference.resourceIdentifier,
      raw,
      importedAt,
      ...(maxChunkCharacters ? { maxChunkCharacters } : {})
    });
    if (!documents.length) {
      skippedMembers.push({ path: reference.path, reason: 'no extractable text' });
      warnings.push(`Skipped '${reference.path}': it contains no extractable text.`);
      continue;
    }

    documentsProduced += 1;
    chunksProduced += documents.length;
    pending.push(...documents);
    // A member with many chunks must not push a batch past the bound the
    // indexing function relies on.
    while (pending.length >= batchSize) await flush(batchSize);
  }

  await flush();

  if (!chunksProduced) {
    // A package can now be well-formed and still yield nothing, if everything
    // in it was an assessment or metadata. Saying so is the difference between
    // a professor re-exporting a course pointlessly and understanding why.
    const excluded = Object.values(excludedCounts).reduce((total, count) => total + count, 0);
    throw validationError(excluded
      ? `The archive contains no teaching content: all ${excluded} referenced file(s) were excluded as assessments, metadata, or unreadable content.`
      : 'The archive contains no manifest-referenced text content.');
  }

  return {
    importId,
    professorId,
    courseName: manifest.courseName,
    courseNameSource: manifest.courseNameSource,
    cartridgeIdentifier: manifest.cartridgeIdentifier,
    archiveSha256,
    parserVersion: PARSER_VERSION,
    membersInspected: archive.members.size,
    documentsProduced,
    chunksProduced,
    excludedCounts,
    excludedSamples,
    skippedMembers,
    warnings,
    batches: batches.map((batch) => batch.name),
    batchDocumentCounts: batches.map((batch) => batch.documents),
    completedAt: new Date().toISOString()
  };
}

module.exports = { DEFAULT_BATCH_SIZE, PARSER_VERSION, TEXT_EXTENSIONS, batchName, extractCourseContent };
