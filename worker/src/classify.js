'use strict';

// Decides whether a manifest reference is teaching material.
//
// This is the boundary that keeps evaluations out of the tutor's knowledge
// base. It is a pure function over a reference's declared resource type and its
// path, so the full table of real cartridge types can be tested exhaustively
// without an archive, a course, or Azure.
//
// The rule is an allowlist, not a denylist, and the distinction is the whole
// point: an unrecognised resource type is excluded. A future Canvas export that
// introduces a new kind of quiz is therefore dropped rather than published to
// students, and the cost of being wrong is a missing page rather than a leaked
// exam.

const path = require('node:path');

// Only general web content is teaching material. Every other cartridge type is
// either an evaluation, a pointer, or packaging metadata:
//
//   imsqti_xmlv1p2/imscc_xmlv1p1/assessment    quizzes and exams
//   imsqti_xmlv1p2/imscc_xmlv1p1/question-bank question banks
//   assignment_xmlv1p0                         assignments
//   associatedcontent/.../learning-application-resource
//                                              Canvas settings, rubrics, and
//                                              assignment metadata
//   imsdt_xmlv1p1 | 1p2 | 1p3                  discussion topics, which may be
//                                              graded and cannot be told apart
//                                              from the resource alone
//   imswl_xmlv1p1 | 1p2 | 1p3                  external web links
//   imsbasiclti_xmlv1p0 | _xmlv1p3             LTI tool launches
const TEACHING_RESOURCE_TYPES = new Set(['webcontent']);

// Canvas writes several of its own bookkeeping files as plain webcontent, so
// type alone does not exclude them.
const EXCLUDED_PATH_PREFIXES = [
  'course_settings/',
  'assignment_settings/',
  'non_cc_assessments/'
];

const EXCLUDED_FILE_NAMES = new Set([
  'assessment_qti.xml',
  'assessment_meta.xml',
  'assignment_settings.xml',
  'files_meta.xml',
  'module_meta.xml',
  'course_settings.xml',
  'assignment_groups.xml',
  'grading_standards.xml',
  'late_policy.xml',
  'rubrics.xml',
  'context.xml',
  'media_tracks.xml',
  'canvas_export.txt',
  'imsmanifest.xml'
]);

// The syllabus is course information rather than an evaluation. It is kept even
// though Canvas files it under course_settings, because it is the single page
// students ask about most, and it contains no questions or answers.
const SYLLABUS_NAME = 'syllabus.html';

// Reasons are stable strings so the completion manifest can be counted by
// reason without parsing prose.
const REASONS = {
  assessment: 'assessment or evaluation content',
  metadata: 'course metadata rather than teaching material',
  unsupportedType: 'resource type is not teaching material'
};

// The reason an exclusion is attributed to matters for the counts a professor
// is shown, so the evaluation types are named rather than folded into the
// generic unsupported-type case.
const ASSESSMENT_TYPE_PATTERN = /(^|\/)(imsqti|assignment_xmlv1p0)|question-bank|assessment/i;

function normalize(referencePath) {
  return String(referencePath || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

// The path is consulted even when the type gate has already decided to exclude,
// because the reason a professor is shown should name what the file actually is.
// Canvas declares assignment_settings as associated content rather than as an
// assignment, so type alone would report a whole course's assignments as merely
// 'unsupported'.
function reasonFromPath(normalized, fileName) {
  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return prefix === 'course_settings/' ? REASONS.metadata : REASONS.assessment;
    }
  }
  if (fileName === 'assessment_qti.xml' || fileName === 'assessment_meta.xml') return REASONS.assessment;
  if (EXCLUDED_FILE_NAMES.has(fileName)) return REASONS.metadata;
  return '';
}

function classifyReference(reference = {}) {
  const normalized = normalize(reference.path);
  const fileName = path.posix.basename(normalized);
  const resourceType = String(reference.resourceType || '').trim();
  const pathReason = reasonFromPath(normalized, fileName);

  if (!TEACHING_RESOURCE_TYPES.has(resourceType)) {
    if (ASSESSMENT_TYPE_PATTERN.test(resourceType)) return { include: false, reason: REASONS.assessment };
    return { include: false, reason: pathReason || REASONS.unsupportedType };
  }

  if (fileName === SYLLABUS_NAME) return { include: true };
  if (pathReason) return { include: false, reason: pathReason };

  return { include: true };
}

module.exports = {
  EXCLUDED_FILE_NAMES,
  EXCLUDED_PATH_PREFIXES,
  REASONS,
  SYLLABUS_NAME,
  TEACHING_RESOURCE_TYPES,
  classifyReference
};
