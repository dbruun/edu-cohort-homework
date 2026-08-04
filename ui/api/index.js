const { app } = require('@azure/functions');
const { DefaultAzureCredential } = require('@azure/identity');
const { loadImsccDocuments } = require('./imscc');
const { readPolicy, writePolicy } = require('./policy');

function professorFromRequest(request) {
  const encoded = request.headers.get('x-ms-client-principal');
  if (!encoded) throw new Error('Authentication is required.');
  const principal = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const roles = principal.userRoles || [];
  if (!roles.includes('professor')) throw new Error('Professor access is required.');
  const claims = Object.fromEntries((principal.claims || []).map((claim) => [claim.typ, claim.val]));
  const id = claims.oid || claims.sub;
  if (!id) throw new Error('Authenticated identity has no stable identifier.');
  return { id, name: claims.name || principal.userDetails || 'Professor' };
}

async function importDocuments(documents) {
  const searchEndpoint = process.env.SEARCH_ENDPOINT;
  const openAiEndpoint = process.env.OPENAI_ENDPOINT;
  const deployment = process.env.EMBEDDING_DEPLOYMENT || 'text-embedding-3-small';
  if (!searchEndpoint || !openAiEndpoint) throw new Error('Search and OpenAI endpoints are not configured.');
  const credential = new DefaultAzureCredential();
  const [searchToken, openAiToken] = await Promise.all([
    credential.getToken('https://search.azure.com/.default'),
    credential.getToken('https://cognitiveservices.azure.com/.default')
  ]);
  const embeddingsResponse = await fetch(
    `${openAiEndpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=2024-10-21`,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + openAiToken.token,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ input: documents.map((document) => `${document.title}\n${document.subject}\n\n${document.content}`), dimensions: 1536 })
    }
  );
  if (!embeddingsResponse.ok) throw new Error('Unable to create document embeddings.');
  const embeddings = (await embeddingsResponse.json()).data.sort((a, b) => a.index - b.index);
  const index = process.env.SEARCH_INDEX_NAME || 'course-materials';
  const uploadResponse = await fetch(
    `${searchEndpoint.replace(/\/$/, '')}/indexes/${encodeURIComponent(index)}/docs/index?api-version=2026-04-01`,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + searchToken.token,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ value: documents.map((document, index) => ({ '@search.action': 'mergeOrUpload', ...document, contentVector: embeddings[index].embedding })) })
    }
  );
  if (!uploadResponse.ok) throw new Error('Unable to add course content to Azure AI Search.');
}

function handler(action) {
  return async (request, context) => {
    try {
      return await action(request, context, professorFromRequest(request));
    } catch (error) {
      const status = /required|Authentication/.test(error.message) ? 403 : 400;
      return { status, jsonBody: { error: error.message } };
    }
  };
}

app.http('policy', {
  route: 'policy',
  methods: ['GET', 'PUT'],
  authLevel: 'anonymous',
  handler: handler(async (request, _context, professor) => {
    if (request.method === 'GET') return { jsonBody: await readPolicy(professor) };
    return { jsonBody: await writePolicy(professor, await request.json()) };
  })
});

app.http('imsccImport', {
  route: 'imscc-import',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: handler(async (request, _context, professor) => {
    const subject = request.headers.get('x-course-subject')?.trim();
    if (!subject || subject.length > 200) throw new Error('A course subject of up to 200 characters is required.');
    const documents = await loadImsccDocuments(Buffer.from(await request.arrayBuffer()), subject);
    await importDocuments(documents);
    return { status: 201, jsonBody: { imported: documents.length, professorId: professor.id } };
  })
});
