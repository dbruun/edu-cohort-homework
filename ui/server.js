const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { professorFromHeaders } = require('./api/auth');
const { importDocuments } = require('./api/documents');
const { loadImsccDocuments } = require('./api/imscc');
const { readPolicy, writePolicy } = require('./api/policy');

const port = Number(process.env.PORT || 8080);
const appDirectory = path.join(__dirname, 'app', 'dist');
const maxArchiveBytes = 50 * 1024 * 1024;

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handleApi(request, response, pathname) {
  const professor = professorFromHeaders(request.headers);
  if (pathname === '/api/policy' && request.method === 'GET') {
    return sendJson(response, 200, await readPolicy(professor));
  }
  if (pathname === '/api/policy' && request.method === 'PUT') {
    const body = JSON.parse((await readBody(request, 1024 * 1024)).toString('utf8'));
    return sendJson(response, 200, await writePolicy(professor, body));
  }
  if (pathname === '/api/imscc-import' && request.method === 'POST') {
    const subject = request.headers['x-course-subject']?.trim();
    if (!subject || subject.length > 200) throw new Error('A course subject of up to 200 characters is required.');
    const documents = await loadImsccDocuments(await readBody(request, maxArchiveBytes), subject);
    await importDocuments(documents);
    return sendJson(response, 201, { imported: documents.length, professorId: professor.id });
  }
  sendJson(response, 404, { error: 'API route not found.' });
}

function serveApp(response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const candidate = path.resolve(appDirectory, relativePath);
  const filePath = candidate.startsWith(appDirectory) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : path.join(appDirectory, 'index.html');
  const extension = path.extname(filePath);
  const contentType = extension === '.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
  response.writeHead(200, {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin'
  });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
  try {
    if (pathname.startsWith('/api/')) await handleApi(request, response, pathname);
    else serveApp(response, pathname);
  } catch (error) {
    const status = /required|Authentication/.test(error.message) ? 401 : /too large/.test(error.message) ? 413 : 400;
    sendJson(response, status, { error: error.message });
  }
});

if (require.main === module) {
  server.listen(port, () => console.log(`Professor portal listening on port ${port}.`));
}

module.exports = { server };