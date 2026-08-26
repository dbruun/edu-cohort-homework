'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { extractCourseContent } = require('../src/extract');

const fixture = (name) => path.join(__dirname, '..', '..', 'scripts', 'tests', 'fixtures', name);

function collector() {
  const written = new Map();
  return {
    written,
    writeBatch: async (name, body) => {
      written.set(name, body);
    },
    documents: () => [...written.values()]
      .flatMap((body) => body.trim().split('\n'))
      .map((line) => JSON.parse(line))
  };
}

async function extract(name, overrides = {}) {
  const sink = collector();
  const manifest = await extractCourseContent({
    archivePath: fixture(name),
    professorId: 'prof-a',
    importId: 'import-1',
    archiveSha256: 'sha-256-of-the-archive',
    importedAt: '2026-08-20T00:00:00Z',
    writeBatch: sink.writeBatch,
    ...overrides
  });
  return { manifest, sink };
}

test('extracts a full Canvas export into documents and a completion manifest', async () => {
  const { manifest, sink } = await extract('biology-101-full.imscc');

  assert.equal(manifest.courseName, 'Biology 101');
  assert.equal(manifest.courseNameSource, 'manifest.organization.title');
  assert.equal(manifest.cartridgeIdentifier, 'canvas.course.export.biology101');
  assert.equal(manifest.archiveSha256, 'sha-256-of-the-archive');
  assert.equal(manifest.parserVersion, '1.1.0');
  // Two of the ten referenced files are assignments and are no longer indexed.
  assert.equal(manifest.documentsProduced, 6);
  assert.equal(manifest.membersInspected, 9);
  assert.deepEqual(manifest.batches, ['batch-00001.ndjson']);
  assert.equal(manifest.chunksProduced, sink.documents().length);
  assert.deepEqual(manifest.skippedMembers, []);
  assert.deepEqual(manifest.warnings, []);
});

// The guarantee this whole classifier exists for, asserted against a real
// cartridge rather than a synthetic reference.
test('never indexes assignments from a real Canvas export', async () => {
  const { manifest, sink } = await extract('biology-101-full.imscc');

  const paths = sink.documents().map((document) => document.sourcePath);
  assert.ok(
    paths.every((p) => !p.startsWith('assignment_settings/')),
    `no assignment may be indexed, found: ${paths.join(', ')}`
  );
  assert.equal(manifest.excludedCounts['assessment or evaluation content'], 2);
  assert.deepEqual(
    manifest.excludedSamples.map((sample) => sample.path).sort(),
    [
      'assignment_settings/lab-02-osmosis-in-potato-cores.xml',
      'assignment_settings/problem-set-01-magnification-and-scale.xml'
    ]
  );
});

test('keeps the syllabus and the weekly teaching pages', async () => {
  const { sink } = await extract('biology-101-full.imscc');
  const paths = sink.documents().map((document) => document.sourcePath);

  assert.ok(paths.some((p) => p.includes('syllabus')), 'the syllabus must survive classification');
  assert.ok(paths.some((p) => p.includes('week-01')), 'weekly pages must survive classification');
});

test('writes documents that trace back to the professor, import, member, and chunk', async () => {
  const { sink } = await extract('biology-101-full.imscc');
  const documents = sink.documents();
  const syllabus = documents.find((document) => document.sourcePath.includes('syllabus'));

  assert.equal(syllabus.professorId, 'prof-a');
  assert.equal(syllabus.importId, 'import-1');
  assert.equal(syllabus.courseName, 'Biology 101');
  assert.equal(syllabus.resourceIdentifier, 'wiki-syllabus');
  assert.equal(syllabus.importedAt, '2026-08-20T00:00:00Z');
  assert.equal(syllabus.isActive, false);
  assert.match(syllabus.content, /grading/i);
  assert.ok(!syllabus.content.includes('<'), 'markup must not reach the index');

  // The whole point of the id scheme: no two chunks anywhere collide.
  assert.equal(new Set(documents.map((document) => document.id)).size, documents.length);
});

test('produces identical output when the same archive is imported again', async () => {
  const first = await extract('biology-101-full.imscc');
  const second = await extract('biology-101-full.imscc');
  assert.deepEqual(second.sink.documents(), first.sink.documents());
});

test('changes every document id when the import id changes', async () => {
  const first = await extract('biology-101-full.imscc');
  const second = await extract('biology-101-full.imscc', { importId: 'import-2' });
  const firstIds = new Set(first.sink.documents().map((document) => document.id));
  assert.ok(second.sink.documents().every((document) => !firstIds.has(document.id)));
});

test('splits output into bounded batches', async () => {
  const { manifest, sink } = await extract('biology-101-full.imscc', { batchSize: 3, maxChunkCharacters: 400 });

  assert.ok(manifest.batches.length > 1, 'a small batch size must produce several batches');
  assert.deepEqual(manifest.batches, [...sink.written.keys()]);
  assert.deepEqual(manifest.batches, manifest.batches.slice().sort());
  for (const [name, body] of sink.written) {
    assert.match(name, /^batch-\d{5}\.ndjson$/);
    assert.ok(body.endsWith('\n'));
    assert.ok(body.trim().split('\n').length <= 3, `${name} must not exceed the batch size`);
  }
  assert.equal(manifest.batchDocumentCounts.reduce((total, count) => total + count, 0), manifest.chunksProduced);
});

test('extracts the smaller cartridge that the synchronous importer already handled', async () => {
  const { manifest, sink } = await extract('canvas-biology-101.imscc');
  assert.equal(manifest.courseName, 'Biology 101');
  // The cartridge's assignment is now excluded, leaving only the teaching page.
  assert.equal(manifest.documentsProduced, 1);
  assert.deepEqual(
    sink.documents().map((document) => document.sourcePath).sort(),
    ['wiki_content/week_1_overview.html']
  );
});

test('stops extraction when the import is cancelled', async () => {
  await assert.rejects(
    extract('biology-101-full.imscc', { isCancelled: () => true }),
    (error) => error.cancelled === true
  );
});

test('reports an unreadable archive as a validation failure', async () => {
  await assert.rejects(
    extractCourseContent({
      archivePath: path.join(__dirname, 'extract.test.js'),
      professorId: 'p',
      importId: 'i',
      writeBatch: async () => {}
    }),
    (error) => error.validation === true && /not a readable ZIP archive/.test(error.message)
  );
});
