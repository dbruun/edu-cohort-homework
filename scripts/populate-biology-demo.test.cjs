const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createDemoPolicy, validateCourseDocuments } = require('./populate-biology-demo.cjs');

test('replaces legacy groups with the biology demo while preserving identity, defaults, and citation choices', () => {
  const original = {
    professorId: 'demo-professor', professorName: 'Demo Professor',
    helpLevel: 'guided', citationsRequired: true, subjectOverrides: { math: 'guided' },
    courseGroups: [
      { name: 'Biology', courses: [{ id: 'BIO201', description: 'Microbiology' }, { id: 'BIO310', description: 'Advanced' }],
        helpLevel: 'guided', citationsRequired: false },
      { name: 'Chemistry', courses: [{ id: 'CHM101', description: 'Chemistry' }], helpLevel: 'worked_example' },
      { name: 'Physics', courses: [], helpLevel: 'full_solution' }
    ]
  };
  const saved = structuredClone(original);
  const next = createDemoPolicy(original);
  assert.deepEqual(original, saved);
  assert.deepEqual(next.courseGroups.map(group => [group.courses[0].id, group.helpLevel, group.citationsRequired]), [
    ['BIO201', 'guided', false], ['BIO310', 'worked_example', false], ['BIO410', 'full_solution', true]
  ]);
  for (const field of ['professorId', 'professorName', 'helpLevel', 'citationsRequired', 'subjectOverrides']) {
    assert.deepEqual(next[field], original[field]);
  }
  assert.doesNotMatch(next.policyText, /CHM101|Chemistry|Physics/);
  assert.deepEqual(createDemoPolicy(next), next);
});

test('rejects mixed-course documents and duplicate IDs before any cloud writes', () => {
  const document = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data', 'bio310.json'), 'utf8'))[0];
  assert.throws(() => validateCourseDocuments([document], 'BIO410 Quantitative Microbiology'));
  assert.throws(() => validateCourseDocuments([document, document], document.courseName));
  assert.throws(() => validateCourseDocuments([{ ...document, content: '' }], document.courseName));
});

test('both source packs contain complete, distinct, course-labelled teaching material', () => {
  for (const [file, course] of [['bio310.json', 'BIO310 Advanced Microbiology'], ['bio410.json', 'BIO410 Quantitative Microbiology']]) {
    const documents = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data', file), 'utf8'));
    validateCourseDocuments(documents, course);
    assert(documents.every(document => document.content.includes(`Original ${course.split(' ')[0]} demo course notes`)));
  }
});
