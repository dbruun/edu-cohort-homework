const { DefaultAzureCredential } = require('@azure/identity');
const { BlobServiceClient } = require('@azure/storage-blob');

const defaultPolicy = {
 helpLevel: 'guided',
 maxStepsRevealed: 3,
 allowDirectAnswers: false,
 citationsRequired: true,
 subjectOverrides: {},
 courseGroups: []
};

function getPolicyClient(professorId) {
 const accountName = process.env.POLICY_STORAGE_ACCOUNT;
 if (!accountName) throw new Error('POLICY_STORAGE_ACCOUNT is not configured.');
 const service = new BlobServiceClient(
   `https://${accountName}.blob.core.windows.net`,
   new DefaultAzureCredential()
 );
 return service.getContainerClient('policies').getBlockBlobClient(`${professorId}.json`);
}

function validatePolicy(policy) {
 if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
   throw new Error('Policy must be an object.');
 }
 if (!['hint_only', 'guided', 'worked_example', 'full_solution'].includes(policy.helpLevel)) {
   throw new Error('Policy helpLevel is invalid.');
 }
 if (!Number.isInteger(policy.maxStepsRevealed) || policy.maxStepsRevealed < 1 || policy.maxStepsRevealed > 8) {
   throw new Error('Policy maxStepsRevealed must be an integer from 1 to 8.');
 }
 if (typeof policy.allowDirectAnswers !== 'boolean' || typeof policy.citationsRequired !== 'boolean') {
   throw new Error('Policy boolean controls are invalid.');
 }
}

async function readPolicy(professor) {
 const blob = getPolicyClient(professor.id);
 try {
   const response = await blob.download();
   return JSON.parse(await streamToString(response.readableStreamBody));
 } catch (error) {
   if (error.statusCode === 404) {
     return { ...defaultPolicy, professorId: professor.id, professorName: professor.name };
   }
   throw error;
 }
}

async function writePolicy(professor, policy) {
 validatePolicy(policy);
 const savedPolicy = {
   ...defaultPolicy,
   ...policy,
   professorId: professor.id,
   professorName: professor.name
 };
 await getPolicyClient(professor.id).upload(
   JSON.stringify(savedPolicy),
   Buffer.byteLength(JSON.stringify(savedPolicy)),
   { blobHTTPHeaders: { blobContentType: 'application/json' } }
 );
 return savedPolicy;
}

async function streamToString(stream) {
 const chunks = [];
 for await (const chunk of stream) chunks.push(chunk);
 return Buffer.concat(chunks).toString('utf8');
}

module.exports = { readPolicy, writePolicy, validatePolicy };
