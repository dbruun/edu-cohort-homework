const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadImsccDocuments } = require('../imscc');

const archive = fs.readFileSync(path.join(
  __dirname,
  '../../../scripts/tests/fixtures/canvas-biology-101.imscc'
));

function replaceAll(buffer, from, to) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
  const copy = Buffer.from(buffer);
  let offset = copy.indexOf(from);
  assert.notEqual(offset, -1);
  while (offset !== -1) {
    copy.write(to, offset);
    offset = copy.indexOf(from, offset + Buffer.byteLength(to));
  }
  return copy;
}

test('imports manifest-listed Canvas HTML and assignment XML as course content', async () => {
  const documents = await loadImsccDocuments(archive, 'Biology 101');

  assert.deepEqual(documents.map(({ title, content, subject, url }) => ({ title, content, subject, url })), [
    {
      title: 'week_1_overview',
      content: 'Week 1 overview Week 1: Cells Review the cell theory before class.',
      subject: 'Biology 101',
      url: 'imscc://portal/wiki_content%2Fweek_1_overview.html'
    },
    {
      title: 'cell_observation',
      content: 'Cell observation Observe one prepared specimen and submit your notes. 10',
      subject: 'Biology 101',
      url: 'imscc://portal/assignment_settings%2Fcell_observation.xml'
    }
  ]);
});

test('rejects empty, non-archive, and manifest-less uploads', async () => {
  await assert.rejects(loadImsccDocuments(Buffer.alloc(0), 'Biology 101'), /non-empty file/);
  await assert.rejects(loadImsccDocuments(Buffer.from('not a zip'), 'Biology 101'));
  await assert.rejects(
    loadImsccDocuments(replaceAll(archive, 'imsmanifest.xml', 'notmanifest.xml'), 'Biology 101'),
    /imsmanifest.xml/
  );
});
