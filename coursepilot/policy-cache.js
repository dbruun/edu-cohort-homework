const { BlobServiceClient } = require('@azure/storage-blob');
const { applyProfessorIdentity, validatePolicy, renderPolicyText } = require('../ui/api/policy');

const normalize = (value) => value.trim().toLowerCase();

function createPolicyCache({ loadPolicies, ttlMs = 15 * 60 * 1000, now = Date.now }) {
  let snapshot;
  let expiresAt = 0;
  let loading;
  async function warm() {
    if (snapshot && now() < expiresAt) return 'hit';
    if (!loading) {
      loading = (async () => {
        const policies = await loadPolicies();
        const next = new Map();
        for (const policy of policies) {
          validatePolicy(policy);
          if (typeof policy.professorId !== 'string' || !policy.professorId.trim() ||
              typeof policy.professorName !== 'string' || !policy.professorName.trim()) {
            throw new Error('A stored policy is missing its professor identity.');
          }
          const key = normalize(policy.professorName);
          if (next.has(key)) throw new Error('Stored policies contain an ambiguous professor name.');
          next.set(key, {
            professorName: policy.professorName,
            policyText: renderPolicyText(policy, { name: policy.professorName })
          });
        }
        if (!next.size) throw new Error('No teaching policies are available.');
        snapshot = next;
        expiresAt = now() + ttlMs;
      })().finally(() => { loading = undefined; });
    }
    await loading;
    return 'reload';
  }
  return {
    warm,
    async get(professorName) {
      const cache = await warm();
      const policy = snapshot.get(normalize(professorName));
      if (!policy) throw new Error('No teaching policy matches the selected professor.');
      return { ...policy, cache };
    }
  };
}

function createStoragePolicyCache({ accountName, credential }) {
  if (!/^[a-z0-9]{3,24}$/.test(accountName || '')) throw new Error('A valid policy storage account is required.');
  const container = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`, credential
  ).getContainerClient('policies');
  return createPolicyCache({
    async loadPolicies() {
      const policies = [];
      const abortSignal = AbortSignal.timeout(30000);
      for await (const item of container.listBlobsFlat({ abortSignal })) {
        if (!item.name.endsWith('.json')) continue;
        const raw = await container.getBlockBlobClient(item.name).downloadToBuffer(0, undefined, {
          abortSignal, maxRetryRequests: 1
        });
        const parsed = JSON.parse(raw.toString('utf8'));
        policies.push(applyProfessorIdentity(parsed, { id: parsed.professorId, name: parsed.professorName }));
      }
      return policies;
    }
  });
}

module.exports = { createPolicyCache, createStoragePolicyCache };
