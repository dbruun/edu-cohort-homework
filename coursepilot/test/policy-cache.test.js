const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPolicyCache } = require('../policy-cache');

const policy = {
  professorId: 'prof-1', professorName: 'Professor One',
  helpLevel: 'guided', citationsRequired: true,
  subjectOverrides: {},
  courseGroups: [{
    name: 'Biology', courses: [{ id: 'BIO201', description: 'Microbiology' }],
    helpLevel: 'worked_example', citationsRequired: true
  }]
};

test('startup preloading serves cache hits without storage reads and preserves distinct professors and groups', async () => {
  let loads = 0;
  const cache = createPolicyCache({
    loadPolicies: async () => {
      loads++;
      return [policy, { ...policy, professorId: 'prof-2', professorName: 'Professor Two', helpLevel: 'full_solution' }];
    }
  });
  await cache.warm();
  const first = await cache.get(' professor one ');
  assert.equal(first.cache, 'hit');
  assert.match(first.policyText, /Default help level: guided/);
  assert.match(first.policyText, /help level worked_example/);
  const second = await cache.get('Professor Two');
  assert.match(second.policyText, /Default help level: full_solution/);
  assert.equal(loads, 1);
});

test('saved changes wait for expiry and simultaneous requests share one reload', async () => {
  let clock = 0;
  let loads = 0;
  let stored = policy;
  let release;
  const cache = createPolicyCache({
    ttlMs: 900000, now: () => clock,
    loadPolicies: async () => {
      loads++;
      if (loads > 1) await new Promise(resolve => { release = resolve; });
      return [stored];
    }
  });
  await cache.warm();
  stored = { ...policy, helpLevel: 'full_solution' };
  clock = 899999;
  assert.match((await cache.get('Professor One')).policyText, /Default help level: guided/);
  clock = 900000;
  const first = cache.get('Professor One');
  const second = cache.get('Professor One');
  assert.equal(loads, 2);
  release();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.cache, 'reload');
    assert.match(result.policyText, /Default help level: full_solution/);
  }
  assert.equal((await cache.get('Professor One')).cache, 'hit');
});

test('expired cache fails closed on refresh failure and can recover without caching the error', async () => {
  let clock = 0;
  let fail = false;
  const cache = createPolicyCache({
    now: () => clock, ttlMs: 10,
    loadPolicies: async () => {
      if (fail) throw new Error('Storage unavailable');
      return [policy];
    }
  });
  await cache.warm();
  clock = 11;
  fail = true;
  await assert.rejects(cache.get('Professor One'), /Storage unavailable/);
  fail = false;
  assert.equal((await cache.get('Professor One')).cache, 'reload');
});

test('missing, ambiguous, and invalid policies never select another professor or permissive defaults', async () => {
  const cache = createPolicyCache({ loadPolicies: async () => [policy] });
  await assert.rejects(cache.get('Unknown Professor'), /No teaching policy matches/);
  for (const policies of [
    [],
    [policy, { ...policy, professorId: 'different-id', professorName: ' PROFESSOR ONE ' }],
    [{ ...policy, helpLevel: 'invented-mode' }]
  ]) {
    const invalid = createPolicyCache({ loadPolicies: async () => policies });
    await assert.rejects(invalid.warm());
  }
});

test('legacy step settings and stored prose cannot reintroduce a cap into cached developer policy', async () => {
  const cache = createPolicyCache({
    loadPolicies: async () => [{
      ...policy, maxStepsRevealed: 1,
      policyText: 'Maximum number of solution steps that may be revealed: 1.',
      courseGroups: [{ ...policy.courseGroups[0], helpLevel: 'full_solution', maxStepsRevealed: 2 }]
    }]
  });
  const cached = await cache.get('Professor One');
  assert.match(cached.policyText, /Default help level: guided/);
  assert.match(cached.policyText, /help level full_solution/);
  assert.doesNotMatch(cached.policyText, /maxStepsRevealed|maximum|steps|undefined/i);
});
