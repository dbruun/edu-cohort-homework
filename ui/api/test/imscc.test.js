const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadImsccDocuments } = require('../imscc');

const archive = fs.readFileSync(path.join(
  __dirname,
  '../../../scripts/tests/fixtures/canvas-biology-101.imscc'
));

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
