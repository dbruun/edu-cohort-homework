const { DefaultAzureCredential } = require('@azure/identity');

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
  if (!embeddingsResponse.ok) {
    throw new Error(`Embedding request failed (HTTP ${embeddingsResponse.status}): ${(await embeddingsResponse.text()).slice(0, 300)}`);
  }
  const embeddings = (await embeddingsResponse.json()).data.sort((a, b) => a.index - b.index);
  const indexName = process.env.SEARCH_INDEX_NAME || 'course-content-index';
  const uploadResponse = await fetch(
    `${searchEndpoint.replace(/\/$/, '')}/indexes/${encodeURIComponent(indexName)}/docs/index?api-version=2026-04-01`,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + searchToken.token,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ value: documents.map((document, position) => ({ '@search.action': 'mergeOrUpload', ...document, contentVector: embeddings[position].embedding })) })
    }
  );
  // A missing index reports 404 here. The index is owned by
  // scripts/setup-knowledge-bases.ps1, so say that rather than guessing.
  if (!uploadResponse.ok) {
    throw new Error(`Search upload to index '${indexName}' failed (HTTP ${uploadResponse.status}): ${(await uploadResponse.text()).slice(0, 300)}`);
  }
  return documents.length;
}

module.exports = { importDocuments };