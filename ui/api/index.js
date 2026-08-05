const { app } = require('@azure/functions');
const { professorFromHeaders } = require('./auth');
const { importDocuments } = require('./documents');
const { loadImsccDocuments } = require('./imscc');
const { readPolicy, writePolicy } = require('./policy');

function professorFromRequest(request) {
  return professorFromHeaders(request.headers);
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
