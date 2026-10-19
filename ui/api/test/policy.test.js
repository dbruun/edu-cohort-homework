const test = require('node:test');
const assert = require('node:assert/strict');
const { applyProfessorIdentity, validatePolicy, renderPolicyText } = require('../policy');

const policy = {
  helpLevel: 'guided',
  maxStepsRevealed: 3,
  citationsRequired: true,
  subjectOverrides: { science: 'guided' },
  courseGroups: [{
    name: 'Intro CS',
    courses: [{ id: 'CS101', description: 'Introduction to Programming' }],
    helpLevel: 'guided',
    maxStepsRevealed: 1,
    citationsRequired: true
  }]
};

test('accepts course-specific restrictive policy configuration', () => {
  assert.doesNotThrow(() => validatePolicy(policy));
});

test('drops obsolete direct-answer flags without changing help styles or other limits', () => {
  const cleaned = applyProfessorIdentity({
    ...policy,
    helpLevel: 'full_solution',
    allowDirectAnswers: false,
    courseGroups: [{ ...policy.courseGroups[0], allowDirectAnswers: true }]
  }, { id: 'current-id', name: 'Professor Test' });
  assert.equal(cleaned.helpLevel, 'full_solution');
  assert.equal(cleaned.maxStepsRevealed, policy.maxStepsRevealed);
  assert.equal(cleaned.courseGroups[0].helpLevel, 'guided');
  assert.equal(cleaned.courseGroups[0].maxStepsRevealed, 1);
  assert.equal(cleaned.citationsRequired, true);
  assert.equal(Object.hasOwn(cleaned, 'allowDirectAnswers'), false);
  assert.equal(Object.hasOwn(cleaned.courseGroups[0], 'allowDirectAnswers'), false);
  assert.doesNotThrow(() => validatePolicy(cleaned));
  const text = renderPolicyText(cleaned, { name: 'Professor Test' });
  assert.match(text, /Default help level: full_solution/);
  assert.match(text, /help level guided/);
  assert.doesNotMatch(text, /direct answers/i);
});

test('rejects disabled hint-only settings in defaults, subjects, and course groups', () => {
  assert.throws(() => validatePolicy({
    ...policy, helpLevel: 'hint_only'
  }), /helpLevel is invalid/);
  assert.throws(() => validatePolicy({
    ...policy, subjectOverrides: { science: 'hint_only' }
  }), /subject overrides are invalid/);
  assert.throws(() => validatePolicy({
    ...policy, courseGroups: [{ ...policy.courseGroups[0], helpLevel: 'hint_only' }]
  }), /course groups are invalid/);
});

test('uses the current signed-in identity instead of stored policy identity', () => {
  assert.deepEqual(applyProfessorIdentity({
    ...policy,
    professorId: 'stored-id',
    professorName: 'Dr. Adams'
  }, {
    id: 'signed-in-id',
    name: 'Professor Ada Lovelace'
  }), {
    ...policy,
    professorId: 'signed-in-id',
    professorName: 'Professor Ada Lovelace'
  });
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
