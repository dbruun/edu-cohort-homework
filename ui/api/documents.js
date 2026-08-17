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

module.exports = { importDocuments };