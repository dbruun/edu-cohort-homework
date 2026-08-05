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
const helpLevels = new Set(['hint_only', 'guided', 'worked_example', 'full_solution']);

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
 if (!helpLevels.has(policy.helpLevel)) {
   throw new Error('Policy helpLevel is invalid.');
 }
 if (!Number.isInteger(policy.maxStepsRevealed) || policy.maxStepsRevealed < 1 || policy.maxStepsRevealed > 8) {
   throw new Error('Policy maxStepsRevealed must be an integer from 1 to 8.');
 }
 if (typeof policy.allowDirectAnswers !== 'boolean' || typeof policy.citationsRequired !== 'boolean') {
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
     (group.maxStepsRevealed !== undefined && (!Number.isInteger(group.maxStepsRevealed) || group.maxStepsRevealed < 1 || group.maxStepsRevealed > 8)) ||
     (group.allowDirectAnswers !== undefined && typeof group.allowDirectAnswers !== 'boolean') ||
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
