const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { EventType } = require('@ag-ui/core');
const { RunAgentInputSchema } = require('@ag-ui/core/schemas');
const { DefaultAzureCredential, ManagedIdentityCredential } = require('@azure/identity');
const { professorFromHeaders: userFromHeaders } = require('../ui/api/auth');
const { streamAgent } = require('./agent');
const { createStoragePolicyCache } = require('./policy-cache');

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readInput(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('The conversation is too large. Start a new chat.'), { status: 413 });
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('A JSON request body is required.'), { status: 400 });
  }
  const parsed = RunAgentInputSchema.safeParse(body);
  if (!parsed.success) throw Object.assign(new Error('Invalid AG-UI run request.'), { status: 400 });
  const input = parsed.data;
  if (!input.messages.length || input.messages.length > 50 ||
      input.messages.at(-1).role !== 'user' ||
      input.messages.some((message) => !['user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' || !message.content.trim() || message.content.length > 10000) ||
      input.tools.length || input.context.length || input.forwardedProps && Object.keys(input.forwardedProps).length) {
    throw Object.assign(new Error('Send up to 50 user/assistant text messages without client tools or instructions.'), { status: 400 });
  }
  return input;
}

function createServer({ endpoint, agentName, agentVersion, credential, policyCache, stream = streamAgent, logger = console }) {
  const rendererHash = createHash('sha256')
    .update(fs.readFileSync(path.join(__dirname, 'public', 'dist', 'response-renderer.js'))).digest('hex').slice(0, 16);
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
    .replace('/dist/response-renderer.js', `/dist/response-renderer.js?v=${rendererHash}`);
  return http.createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'same-origin');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('x-robots-tag', 'noindex, nofollow');
    const pathname = new URL(request.url, 'http://localhost').pathname;
    try {
      if (pathname === '/health' && request.method === 'GET') {
        return json(response, 200, { status: 'ok' });
      }
      let user;
      try {
        user = userFromHeaders(request.headers);
      } catch {
        return json(response, 401, { error: 'Sign in to CourseWise to continue.' });
      }
      if (pathname === '/api/me' && request.method === 'GET') {
        return json(response, 200, { name: user.name });
      }
      if (request.method === 'GET' && /^\/dist\/(?:response-renderer\.js(?:\.LEGAL\.txt)?|katex\.min\.css|fonts\/KaTeX_[A-Za-z0-9_-]+\.(?:woff2?|ttf))$/.test(pathname)) {
        const file = path.join(__dirname, 'public', ...pathname.slice(1).split('/'));
        if (!fs.existsSync(file)) return json(response, 404, { error: 'Rendering assets are missing. Run npm run build before starting CourseWise.' });
        const contentTypes = { '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
        response.writeHead(200, {
          'content-type': contentTypes[path.extname(file)],
          'cache-control': 'public, max-age=3600'
        });
        fs.createReadStream(file).pipe(response);
        return;
      }
      if (pathname === '/' && request.method === 'GET') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        });
        response.end(html);
        return;
      }
      if (pathname !== '/api/chat' || request.method !== 'POST') {
        return json(response, 404, { error: 'Route not found.' });
      }
      const origin = request.headers.origin;
      if (!origin || !['http:', 'https:'].includes(new URL(origin).protocol) ||
          new URL(origin).host !== request.headers.host) {
        return json(response, 403, { error: 'A same-origin request is required.' });
      }
      if (!request.headers['content-type']?.startsWith('application/json')) {
        return json(response, 415, { error: 'Use application/json.' });
      }
      const input = await readInput(request);
      const courseContext = input.state?.courseContext;
      if (policyCache && (!courseContext || typeof courseContext !== 'object' ||
          Object.keys(input.state).some((key) => key !== 'courseContext') ||
          Object.keys(courseContext).some((key) => !['professorName', 'course'].includes(key)) ||
          ['professorName', 'course'].some((key) => typeof courseContext[key] !== 'string' ||
            !courseContext[key].trim() || courseContext[key].length > 100))) {
        return json(response, 400, { error: 'Select a professor and course before starting.' });
      }
      const controller = new AbortController();
      const runStarted = Date.now();
      let firstText = false;
      const timeout = setTimeout(() => controller.abort(new Error('The agent response timed out.')), 240000);
      const abort = () => controller.abort();
      response.once('close', abort);
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no'
      });
      response.flushHeaders();
      const heartbeat = setInterval(() => {
        if (!response.destroyed) response.write(': keep-alive\n\n');
      }, 15000);
      const emit = async (event) => {
        if (controller.signal.aborted) throw new Error('Client disconnected.');
        if (!firstText && event.type === EventType.TEXT_MESSAGE_CONTENT) {
          firstText = true;
          logger.info?.(`[CoursePilot] Run ${input.runId}: firstTextMs=${Date.now() - runStarted}`);
        }
        if (!response.write(`data: ${JSON.stringify(event)}\n\n`)) {
          await once(response, 'drain', { signal: controller.signal });
        }
      };
      try {
        await emit({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
        const started = Date.now();
        let serverPolicy;
        if (policyCache) {
          await emit({ type: EventType.CUSTOM, name: 'coursepilot.status', value: 'Reading teaching policy' });
          serverPolicy = { ...await policyCache.get(courseContext.professorName), course: courseContext.course.trim() };
          logger.info?.(`[CoursePilot] Run ${input.runId}: policyCache=${serverPolicy.cache} policyMs=${Date.now() - started}`);
          await emit({ type: EventType.CUSTOM, name: 'coursepilot.sources', value: [{ id: 'policy', kind: 'policy', title: 'Teaching policy' }] });
        }
        await emit({ type: EventType.CUSTOM, name: 'coursepilot.status', value: 'Connecting to your tutor' });
        await stream(input, { endpoint, agentName, agentVersion, credential, serverPolicy, emit, signal: controller.signal });
        logger.info?.(`[CoursePilot] Run ${input.runId}: totalMs=${Date.now() - runStarted}`);
        await emit({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
      } catch (error) {
        if (!response.destroyed) {
          logger.error(`[CoursePilot] Run ${input.runId}: ${error.message}`);
          response.write(`data: ${JSON.stringify({ type: EventType.RUN_ERROR, message: 'Your tutor could not complete the response. Please try again.', code: 'AGENT_ERROR' })}\n\n`);
        }
      } finally {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        response.removeListener('close', abort);
        controller.abort();
        response.end();
      }
    } catch (error) {
      logger.error(`[CoursePilot] Request failed: ${error.message}`);
      if (!response.headersSent) json(response, error.status || 500, { error: error.status ? error.message : 'CourseWise could not handle this request.' });
      else response.destroy();
    }
  });
}

if (require.main === module) {
  const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
  const agentName = process.env.FOUNDRY_AGENT_NAME;
  const agentVersion = process.env.FOUNDRY_AGENT_VERSION;
  if (!endpoint || !agentName || !agentVersion) throw new Error('Foundry project endpoint, agent name, and agent version are required.');
  const credential = process.env.WEBSITE_SITE_NAME ? new ManagedIdentityCredential() : new DefaultAzureCredential();
  const policyCache = createStoragePolicyCache({ accountName: process.env.POLICY_STORAGE_ACCOUNT, credential });
  Promise.all([
    credential.getToken('https://ai.azure.com/.default', { abortSignal: AbortSignal.timeout(30000) }),
    policyCache.warm()
  ]).then(([token]) => {
    if (!token) throw new Error('Azure did not return an access token during startup.');
    createServer({ endpoint, agentName, agentVersion, credential, policyCache }).listen(
      Number(process.env.PORT || 8080), () => console.log('CoursePilot is listening; teaching policies and Azure authentication are warmed.')
    );
  }).catch((error) => {
    console.error(`[CoursePilot] Startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { createServer, readInput };
