const fs = require('fs');
const path = require('path');

function getPolicyPath() {
  return path.join(process.cwd(), '..', '..', 'src', 'HomeworkAgent', 'Pedagogy', 'pedagogy-policy.json');
}

function readPolicy() {
  const policyPath = getPolicyPath();
  if (!fs.existsSync(policyPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(policyPath, 'utf8'));
}

function writePolicy(policy) {
  const policyPath = getPolicyPath();
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2));
  return policy;
}

module.exports = { readPolicy, writePolicy, getPolicyPath };
