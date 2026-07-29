'use strict';

/**
 * Thin LTI 1.3 / LTI Advantage tool.
 *
 * ltijs owns the OIDC login, launch validation, and JWKS endpoints and validates
 * the id_token (signature via platform JWKS, iss, aud, nonce replay, exp,
 * deployment_id) before onConnect runs. This service only does role routing:
 * Learner -> tutor chat, Instructor/TA/ContentDeveloper -> professor portal.
 *
 * See docs/lti-integration.md for the full design.
 */

const { Provider: lti } = require('ltijs');
const fs = require('fs');
const path = require('path');

// Tutor chat page served to Learners. AG-UI endpoint is injected at launch time.
const tutorTemplate = fs.readFileSync(path.join(__dirname, 'tutor.html'), 'utf8');

const PORT = Number(process.env.PORT) || 3000;

// Required configuration -----------------------------------------------------
const LTI_KEY = process.env.LTI_KEY; // ltijs encryption key (cookies/state)
const MONGO_URL = process.env.MONGO_URL; // ltijs datastore (Cosmos DB for MongoDB)

if (!LTI_KEY || !MONGO_URL) {
  console.error('Missing required env: LTI_KEY and MONGO_URL must both be set.');
  process.exit(1);
}

// Optional: pre-register a single platform from env so the first launch works
// without a separate registration step. Dynamic Registration can replace this.
const PLATFORM_URL = process.env.PLATFORM_URL; // e.g. https://canvas.instructure.com
const PLATFORM_NAME = process.env.PLATFORM_NAME || 'Registered LMS';
const PLATFORM_CLIENT_ID = process.env.PLATFORM_CLIENT_ID;
const PLATFORM_AUTH_ENDPOINT = process.env.PLATFORM_AUTH_ENDPOINT;
const PLATFORM_TOKEN_ENDPOINT = process.env.PLATFORM_TOKEN_ENDPOINT;
const PLATFORM_KEYSET_ENDPOINT = process.env.PLATFORM_KEYSET_ENDPOINT;
// Static RSA public key for a self-hosted platform. When set, the tool verifies
// launches against this key directly -- no hosted JWKS required. Takes
// precedence over PLATFORM_KEYSET_ENDPOINT. Accepts a raw PEM or, to survive
// single-line env transport, a base64-encoded PEM.
const PLATFORM_PUBLIC_KEY_RAW = process.env.PLATFORM_PUBLIC_KEY;
const PLATFORM_PUBLIC_KEY = PLATFORM_PUBLIC_KEY_RAW && !PLATFORM_PUBLIC_KEY_RAW.includes('BEGIN')
  ? Buffer.from(PLATFORM_PUBLIC_KEY_RAW, 'base64').toString('utf8')
  : PLATFORM_PUBLIC_KEY_RAW;

const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS || "'self'";
const HOMEWORK_AGENT_URL = process.env.HOMEWORK_AGENT_URL || '';

// Public base URL of this tool. Required to advertise endpoints during LTI
// Dynamic Registration. When unset, Dynamic Registration is disabled and only
// manual PLATFORM_* registration is available.
const TOOL_URL = process.env.TOOL_URL || '';
const TOOL_NAME = process.env.TOOL_NAME || 'Homework Tutor';

// ---------------------------------------------------------------------------

const setupOptions = {
  appRoute: '/lti/launch',
  loginRoute: '/login',
  keysetRoute: '/keys',
  // Third-party cookies are partitioned/blocked in LMS iframes. secure + None
  // plus ltijs's platform postMessage storage keeps launches alive.
  cookies: {
    secure: true,
    sameSite: 'None'
  },
  devMode: false
};

// Enable ltijs's built-in Dynamic Registration. An LMS admin pastes
// `${TOOL_URL}/register` and the tool self-configures the platform. Canvas and
// Blackboard both support this. Registration endpoint defaults to /register.
if (TOOL_URL) {
  setupOptions.dynReg = {
    url: TOOL_URL,
    name: TOOL_NAME,
    autoActivate: true
  };
}

lti.setup(LTI_KEY, { url: MONGO_URL }, setupOptions);

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const INSTRUCTOR_ROLE = /Instructor|TeachingAssistant|ContentDeveloper|Administrator/i;
const LEARNER_ROLE = /Learner|Student/i;

function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1b1b1b; }
  .card { max-width: 640px; padding: 1.25rem 1.5rem; border: 1px solid #ddd; border-radius: 8px; }
  h1 { font-size: 1.25rem; margin-top: 0; }
  dt { font-weight: 600; }
  dd { margin: 0 0 .5rem 0; }
  code { background: #f3f3f3; padding: .1rem .3rem; border-radius: 4px; }
</style>
</head>
<body>
<div class="card">
${bodyHtml}
</div>
</body>
</html>`;
}

function launchClaims(token) {
  const ctx = token.platformContext || {};
  const user = token.userInfo || {};
  return {
    name: user.name || ctx.name || '(unknown)',
    email: user.email || '(not released)',
    sub: token.user || '(unknown)',
    contextId: (ctx.context && ctx.context.id) || '(no context)',
    contextTitle: (ctx.context && ctx.context.title) || '',
    roles: ctx.roles || [],
    deploymentId: token.deploymentId || ctx.deploymentId || '',
    iss: token.iss || token.platformId || ''
  };
}

// Role router ---------------------------------------------------------------
lti.onConnect(async (token, req, res) => {
  res.setHeader('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS}`);
  res.removeHeader('X-Frame-Options');

  const claims = launchClaims(token);
  const roles = claims.roles;
  const isInstructor = roles.some((r) => INSTRUCTOR_ROLE.test(r));
  const isLearner = roles.some((r) => LEARNER_ROLE.test(r));

  if (!isInstructor && !isLearner) {
    // Default-deny unknown roles.
    return res.status(403).send(
      page('Access denied', '<h1>Access denied</h1><p>Your LMS role is not permitted to use this tool.</p>')
    );
  }

  const shared = `
    <dl>
      <dt>User</dt><dd>${escapeHtml(claims.name)} &lt;${escapeHtml(claims.email)}&gt;</dd>
      <dt>Course (context_id)</dt><dd><code>${escapeHtml(claims.contextId)}</code> ${escapeHtml(claims.contextTitle)}</dd>
      <dt>Deployment</dt><dd><code>${escapeHtml(claims.deploymentId)}</code></dd>
    </dl>`;

  if (isInstructor) {
    // TODO(phase 2): render the professor portal (ui/app) scoped to context_id,
    // reading/writing per-course pedagogy policy.
    return res.send(
      page(
        'Professor portal',
        `<h1>Professor portal</h1>
         <p>Launched as an <strong>instructor</strong>. This is where the pedagogy portal loads, scoped to this course.</p>
         ${shared}`
      )
    );
  }

  // Learner -> tutor chat. The page streams from the Foundry-backed MAF agent
  // over AG-UI (HOMEWORK_AGENT_URL). CSP already allows framing by the LMS.
  if (!HOMEWORK_AGENT_URL) {
    return res.send(page('Homework tutor', '<h1>Homework tutor</h1><p><em>HOMEWORK_AGENT_URL not configured — tutor unavailable.</em></p>'));
  }
  const agentUrl = HOMEWORK_AGENT_URL.endsWith('/') ? HOMEWORK_AGENT_URL : `${HOMEWORK_AGENT_URL}/`;
  const firstName = (claims.name || '').split(' ')[0];
  const html = tutorTemplate
    .split('__AGENT_URL__').join(agentUrl)
    .split('__STUDENT_NAME__').join(escapeHtml(firstName));
  return res.send(html);
});

async function main() {
  // Apply the same policy to custom routes such as /healthz. LTI launch
  // responses set it directly in onConnect because ltijs registers its routes
  // during setup, before this middleware.
  lti.app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS}`);
    res.removeHeader('X-Frame-Options');
    next();
  });

  // Liveness probe.
  lti.app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));

  // Exempt the probe from ltijs's LTI auth guard so it returns 200, not 401.
  lti.whitelist('/healthz');

  await lti.deploy({ port: PORT });

  if (PLATFORM_URL && PLATFORM_CLIENT_ID && PLATFORM_AUTH_ENDPOINT && PLATFORM_TOKEN_ENDPOINT && (PLATFORM_PUBLIC_KEY || PLATFORM_KEYSET_ENDPOINT)) {
    const authConfig = PLATFORM_PUBLIC_KEY
      ? { method: 'RSA_KEY', key: PLATFORM_PUBLIC_KEY }
      : { method: 'JWK_SET', key: PLATFORM_KEYSET_ENDPOINT };
    await lti.registerPlatform({
      url: PLATFORM_URL,
      name: PLATFORM_NAME,
      clientId: PLATFORM_CLIENT_ID,
      authenticationEndpoint: PLATFORM_AUTH_ENDPOINT,
      accesstokenEndpoint: PLATFORM_TOKEN_ENDPOINT,
      authConfig
    });
    console.log(`Registered platform ${PLATFORM_NAME} (${PLATFORM_URL}) via ${authConfig.method}.`);
  } else {
    console.log('No platform pre-registered via PLATFORM_* env vars.');
  }

  if (TOOL_URL) {
    console.log(`Dynamic Registration enabled at ${TOOL_URL}/register`);
  } else {
    console.log('Dynamic Registration disabled (set TOOL_URL to enable).');
  }

  console.log(`LTI tool listening on :${PORT}`);
}

main().catch((err) => {
  console.error('Failed to start LTI tool:', err);
  process.exit(1);
});
