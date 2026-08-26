'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDocuments, chunkText, documentId, markupToText, toText } = require('../src/documents');

test('extracts readable text from HTML without markup, scripts, or entities', () => {
  const html = `<html><head><title>Week 1 &amp; 2</title><style>.a{color:red}</style></head>
    <body><h1>Cells</h1><script>alert('x')</script><p>Review&nbsp;the cell theory.</p><p>Then rest.</p></body></html>`;
  const { title, text } = toText('wiki_content/week_1.html', html);
  assert.equal(title, 'Week 1 & 2');
  assert.equal(text, 'Week 1 & 2 Cells Review the cell theory. Then rest.');
});

test('keeps adjacent element text separated', () => {
  assert.equal(markupToText('<p>one</p><p>two</p>'), 'one two');
  assert.equal(markupToText('<b>bold</b>text'), 'bold text');
});

test('extracts text from assignment XML and leaves plain text alone', () => {
  assert.equal(
    toText('assignment_settings/lab.xml', '<assignment><title>Lab 2</title><points>10</points></assignment>').text,
    'Lab 2 10'
  );
  assert.equal(toText('notes.txt', '  spaced   out\n\ntext ').text, 'spaced out text');
});

test('chunks long text on word boundaries without dropping or duplicating content', () => {
  const words = Array.from({ length: 400 }, (_, index) => `word${index}`).join(' ');
  const chunks = chunkText(words, 100);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 100, `chunk of ${chunk.length} exceeds the limit`);
  assert.equal(chunks.join(' '), words, 'chunking must preserve the original text exactly');
  for (const chunk of chunks) assert.ok(!/^\s|\s$/.test(chunk));
});

test('splits a single oversized word rather than discarding it', () => {
  const chunks = chunkText('a'.repeat(250), 100);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [100, 100, 50]);
});

test('builds stable document ids that separate professors, imports, members, and chunks', () => {
  const base = { professorId: 'prof-a', importId: 'import-1', sourcePath: 'a.html', chunkNumber: 0 };
  assert.equal(documentId(base), documentId({ ...base }));
  assert.match(documentId(base), /^doc-[0-9a-f]{64}$/);

  const ids = new Set([
    documentId(base),
    documentId({ ...base, professorId: 'prof-b' }),
    documentId({ ...base, importId: 'import-2' }),
    documentId({ ...base, sourcePath: 'b.html' }),
    documentId({ ...base, chunkNumber: 1 })
  ]);
  assert.equal(ids.size, 5, 'every distinguishing field must change the document id');
});

test('carries the traceability fields each document needs', () => {
  const [document] = buildDocuments({
    professorId: 'prof-a',
    importId: 'import-1',
    courseName: 'Biology 101',
    sourcePath: 'wiki_content/week_1.html',
    resourceIdentifier: 'wiki-week-01',
    raw: '<html><title>Week 1</title><body>Cells divide.</body></html>',
    importedAt: '2026-08-20T00:00:00Z'
  });

  assert.deepEqual(document, {
    id: documentId({ professorId: 'prof-a', importId: 'import-1', sourcePath: 'wiki_content/week_1.html', chunkNumber: 0 }),
    professorId: 'prof-a',
    importId: 'import-1',
    courseName: 'Biology 101',
    title: 'Week 1',
    content: 'Week 1 Cells divide.',
    sourcePath: 'wiki_content/week_1.html',
    resourceIdentifier: 'wiki-week-01',
    chunkNumber: 0,
    chunkCount: 1,
    contentHash: document.contentHash,
    importedAt: '2026-08-20T00:00:00Z',
    // Indexed content stays inactive until every batch is confirmed.
    isActive: false
  });
});

test('falls back to the member name when a document has no title', () => {
  const [document] = buildDocuments({
    professorId: 'p',
    importId: 'i',
    courseName: 'c',
    sourcePath: 'assignment_settings/cell_observation.xml',
    resourceIdentifier: 'r',
    raw: '<assignment>Observe a specimen.</assignment>'
  });
  assert.equal(document.title, 'cell_observation');
});

test('produces no documents for a member with no extractable text', () => {
  assert.deepEqual(buildDocuments({
    professorId: 'p',
    importId: 'i',
    courseName: 'c',
    sourcePath: 'empty.html',
    resourceIdentifier: 'r',
    raw: '<html><body><script>var a = 1;</script></body></html>'
  }), []);
});
