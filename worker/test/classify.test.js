'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { REASONS, classifyReference } = require('../src/classify');

// The strings below are the resource types real Canvas and Common Cartridge
// exports emit. They are written out in full rather than generated, because the
// whole guarantee rests on matching them exactly.

const ASSESSMENT_TYPES = [
  'imsqti_xmlv1p2/imscc_xmlv1p1/assessment',
  'imsqti_xmlv1p2/imscc_xmlv1p2/assessment',
  'imsqti_xmlv1p2/imscc_xmlv1p3/assessment',
  'imsqti_xmlv1p2/imscc_xmlv1p1/question-bank',
  'imsqti_xmlv1p2/imscc_xmlv1p3/question-bank',
  'assignment_xmlv1p0'
];

const NON_TEACHING_TYPES = [
  'associatedcontent/imscc_xmlv1p1/learning-application-resource',
  'imsdt_xmlv1p1',
  'imsdt_xmlv1p2',
  'imsdt_xmlv1p3',
  'imswl_xmlv1p1',
  'imswl_xmlv1p2',
  'imswl_xmlv1p3',
  'imsbasiclti_xmlv1p0',
  'imsbasiclti_xmlv1p3'
];

test('excludes every assessment resource type', () => {
  for (const resourceType of ASSESSMENT_TYPES) {
    const verdict = classifyReference({ path: 'anything/file.xml', resourceType });
    assert.equal(verdict.include, false, `${resourceType} must be excluded`);
    assert.equal(verdict.reason, REASONS.assessment, `${resourceType} must be reported as an assessment`);
  }
});

test('excludes discussions, links, LTI and Canvas associated content', () => {
  for (const resourceType of NON_TEACHING_TYPES) {
    const verdict = classifyReference({ path: 'anything/file.html', resourceType });
    assert.equal(verdict.include, false, `${resourceType} must be excluded`);
  }
});

// The allowlist exists for this case above all: a type nobody has seen must not
// reach the tutor merely because no rule named it.
test('excludes an unrecognised resource type rather than admitting it', () => {
  for (const resourceType of ['imsqti_xmlv9p9/future/assessment', 'canvas_future_quiz_v2', '', undefined]) {
    const verdict = classifyReference({ path: 'wiki_content/page.html', resourceType });
    assert.equal(verdict.include, false, `'${resourceType}' must be excluded`);
  }
});

test('includes wiki pages and uploaded files', () => {
  for (const p of [
    'wiki_content/week-01-cell-structure.html',
    'wiki_content/exam-1-study-guide.html',
    'web_resources/lecture-notes.html',
    'web_resources/handouts/week-3.txt',
    'readme.md'
  ]) {
    assert.equal(classifyReference({ path: p, resourceType: 'webcontent' }).include, true, `${p} must be included`);
  }
});

test('excludes Canvas metadata written as plain web content', () => {
  for (const p of [
    'course_settings/module_meta.xml',
    'course_settings/assignment_groups.xml',
    'course_settings/canvas_export.txt',
    'course_settings/rubrics.xml',
    'files_meta.xml',
    'imsmanifest.xml'
  ]) {
    const verdict = classifyReference({ path: p, resourceType: 'webcontent' });
    assert.equal(verdict.include, false, `${p} must be excluded`);
    assert.equal(verdict.reason, REASONS.metadata);
  }
});

// The named files above are all individually listed, so they would still be
// excluded if the folder rule were removed. This covers the folder rule itself:
// a settings file this code has never heard of must still be excluded.
test('excludes an unfamiliar file purely because it sits in course_settings', () => {
  const verdict = classifyReference({
    path: 'course_settings/some_future_canvas_setting.xml',
    resourceType: 'webcontent'
  });
  assert.equal(verdict.include, false);
  assert.equal(verdict.reason, REASONS.metadata);
});

test('excludes assessment files that are declared as plain web content', () => {
  for (const p of [
    'assignment_settings/problem-set-01.xml',
    'non_cc_assessments/quiz-1.xml.qti',
    'i5f7a/assessment_qti.xml',
    'i5f7a/assessment_meta.xml'
  ]) {
    const verdict = classifyReference({ path: p, resourceType: 'webcontent' });
    assert.equal(verdict.include, false, `${p} must be excluded`);
  }
});

// The syllabus is the one deliberate exception to the course_settings rule.
test('keeps the syllabus even though Canvas files it under course settings', () => {
  assert.equal(classifyReference({ path: 'course_settings/syllabus.html', resourceType: 'webcontent' }).include, true);
  assert.equal(classifyReference({ path: 'syllabus.html', resourceType: 'webcontent' }).include, true);
});

test('a syllabus that is an assessment resource is still excluded', () => {
  const verdict = classifyReference({
    path: 'course_settings/syllabus.html',
    resourceType: 'imsqti_xmlv1p2/imscc_xmlv1p1/assessment'
  });
  assert.equal(verdict.include, false, 'the type gate must be decided before the syllabus exception');
});

test('classification does not depend on path casing or separators', () => {
  assert.equal(classifyReference({ path: 'Course_Settings\\Module_Meta.xml', resourceType: 'webcontent' }).include, false);
  assert.equal(classifyReference({ path: './wiki_content/Page.HTML', resourceType: 'webcontent' }).include, true);
});
