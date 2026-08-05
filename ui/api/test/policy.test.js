const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePolicy } = require('../policy');

const policy = {
  helpLevel: 'guided',
  maxStepsRevealed: 3,
  allowDirectAnswers: false,
  citationsRequired: true,
  subjectOverrides: { science: 'hint_only' },
  courseGroups: [{
    name: 'Intro CS',
    courses: [{ id: 'CS101', description: 'Introduction to Programming' }],
    helpLevel: 'hint_only',
    maxStepsRevealed: 1,
    allowDirectAnswers: false,
    citationsRequired: true
  }]
};

test('accepts course-specific restrictive policy configuration', () => {
  assert.doesNotThrow(() => validatePolicy(policy));
});

test('rejects duplicate course assignments and invalid group restrictions', () => {
  assert.throws(() => validatePolicy({
    ...policy,
    courseGroups: [...policy.courseGroups, {
      ...policy.courseGroups[0],
      name: 'Duplicate',
      courses: [{ id: 'cs101', description: 'Duplicate assignment' }]
    }]
  }), /unique, non-empty IDs/);
  assert.throws(() => validatePolicy({
    ...policy,
    courseGroups: [{ ...policy.courseGroups[0], maxStepsRevealed: 9 }]
  }), /course groups are invalid/);
});
