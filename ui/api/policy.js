const { DefaultAzureCredential, ManagedIdentityCredential } = require('@azure/identity');
const { BlobServiceClient } = require('@azure/storage-blob');

const defaultPolicy = {
 helpLevel: 'guided',
 citationsRequired: true,
 subjectOverrides: {},
 courseGroups: []
};
const helpLevels = new Set(['guided', 'worked_example', 'full_solution']);
let credential;
let policyService;
let policyAccount;

function getCredential() {
 return credential ??= process.env.WEBSITE_SITE_NAME ? new ManagedIdentityCredential() : new DefaultAzureCredential();
}

function getPolicyClient(professorId) {
 const accountName = process.env.POLICY_STORAGE_ACCOUNT;
 if (!accountName) throw new Error('POLICY_STORAGE_ACCOUNT is not configured.');
 if (!policyService || policyAccount !== accountName) {
   policyService = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, getCredential());
   policyAccount = accountName;
 }
 return policyService.getContainerClient('policies').getBlockBlobClient(`${professorId}.json`);
}

function validatePolicy(policy) {
 if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
   throw new Error('Policy must be an object.');
 }
 if (!helpLevels.has(policy.helpLevel)) {
   throw new Error('Policy helpLevel is invalid.');
 }
 if (typeof policy.citationsRequired !== 'boolean') {
   throw new Error('Policy boolean controls are invalid.');
 }
 if (!policy.subjectOverrides || typeof policy.subjectOverrides !== 'object' || Array.isArray(policy.subjectOverrides) ||
   Object.values(policy.subjectOverrides).some((helpLevel) => !helpLevels.has(helpLevel))) {
   throw new Error('Policy subject overrides are invalid.');
 }
 if (!Array.isArray(policy.courseGroups)) throw new Error('Policy course groups are invalid.');

 const courseIds = new Set();
 for (const group of policy.courseGroups) {
   if (!group || typeof group !== 'object' || typeof group.name !== 'string' || !Array.isArray(group.courses) ||
     (group.helpLevel !== undefined && !helpLevels.has(group.helpLevel)) ||
     (group.citationsRequired !== undefined && typeof group.citationsRequired !== 'boolean')) {
     throw new Error('Policy course groups are invalid.');
   }
   for (const course of group.courses) {
     const courseId = course?.id?.trim().toLowerCase();
     if (!courseId || typeof course.description !== 'string' || courseIds.has(courseId)) {
       throw new Error('Policy courses must have unique, non-empty IDs.');
     }
     courseIds.add(courseId);
   }
 }
}

async function readPolicy(professor) {
 const blob = getPolicyClient(professor.id);
 try {
   const response = await blob.download();
   return applyProfessorIdentity(JSON.parse(await streamToString(response.readableStreamBody)), professor);
 } catch (error) {
   if (error.statusCode === 404) {
     return applyProfessorIdentity(defaultPolicy, professor);
   }
   throw error;
 }
}

function applyProfessorIdentity(policy, professor) {
 const { allowDirectAnswers, maxStepsRevealed, policyText, ...settings } = policy;
 const normalized = {
   ...settings,
   courseGroups: (settings.courseGroups ?? []).map(({ allowDirectAnswers, maxStepsRevealed, ...group }) => group),
   professorId: professor.id,
   professorName: professor.name
 };
 if (policyText !== undefined) normalized.policyText = renderPolicyText(normalized, professor);
 return normalized;
}

// The policy index grounds the agent on prose, not enum values, and blob JSON
// indexing drops nested objects — so flatten everything into one text field.
function renderPolicyText(policy, professor) {
 const lines = [
   `Pedagogy policy for professor ${professor.name}.`,
   `Default help level: ${policy.helpLevel}.`,
   `Citations to course material are ${policy.citationsRequired ? 'required' : 'not required'}.`
 ];
 const overrides = Object.entries(policy.subjectOverrides ?? {});
 if (overrides.length) {
   lines.push(`Subject overrides: ${overrides.map(([subject, level]) => `${subject} uses ${level}`).join('; ')}.`);
 }
 // Each group states its fully resolved ruleset, so the agent never has to
 // merge a partial override against the defaults itself.
 for (const group of policy.courseGroups ?? []) {
   const courses = (group.courses ?? []).map((course) => course.id).join(', ');
   const helpLevel = group.helpLevel ?? policy.helpLevel;
   const citations = group.citationsRequired ?? policy.citationsRequired;
   lines.push(
     `Course group "${group.name}"${courses ? ` covers courses ${courses}` : ''} and replaces the defaults above for those courses:` +
     ` help level ${helpLevel};` +
     ` citations to course material are ${citations ? 'required' : 'not required'}.`
   );
 }
 return lines.join(' ');
}

async function writePolicy(professor, policy) {
 validatePolicy(policy);
 const savedPolicy = applyProfessorIdentity({
   ...defaultPolicy,
   ...policy
 }, professor);
 savedPolicy.policyText = renderPolicyText(savedPolicy, professor);
 await getPolicyClient(professor.id).upload(
   JSON.stringify(savedPolicy),
   Buffer.byteLength(JSON.stringify(savedPolicy)),
   { blobHTTPHeaders: { blobContentType: 'application/json' } }
 );
 return savedPolicy;
}

// The policy indexer has no schedule, so a saved blob stays invisible to the
// agent until something runs it. Never throws: the policy is already saved.
async function runPolicyIndexer() {
  const searchEndpoint = process.env.SEARCH_ENDPOINT;
  const indexerName = process.env.POLICY_INDEXER_NAME;
  if (!searchEndpoint || !indexerName) {
    const reason = 'SEARCH_ENDPOINT or POLICY_INDEXER_NAME is not configured.';
    console.error('[policy-indexer] ' + reason);
    return { triggered: false, reason };
  }
  const url = `${searchEndpoint.replace(/\/$/, '')}/indexers/${encodeURIComponent(indexerName)}/run?api-version=2024-07-01`;
  try {
    const token = await getCredential().getToken('https://search.azure.com/.default');
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token.token } });
    // 409 means a run is already in flight, which still picks up this blob.
    if (response.ok || response.status === 409) {
      console.log(`[policy-indexer] run accepted (HTTP ${response.status}).`);
      return { triggered: true, reason: `HTTP ${response.status}` };
    }
    const reason = `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
    console.error('[policy-indexer] run rejected. ' + reason);
    return { triggered: false, reason };
  } catch (error) {
    const reason = `${error.name}: ${error.message}`;
    console.error('[policy-indexer] run threw. ' + reason);
    return { triggered: false, reason };
  }
}

async function streamToString(stream) {
 const chunks = [];
 for await (const chunk of stream) chunks.push(chunk);
 return Buffer.concat(chunks).toString('utf8');
}

module.exports = { applyProfessorIdentity, readPolicy, writePolicy, validatePolicy, runPolicyIndexer, renderPolicyText };
