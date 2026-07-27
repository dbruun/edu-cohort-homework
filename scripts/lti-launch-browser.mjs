// Visual LTI 1.3 launch: pops open a real browser on the tutor chat.
//
// Same handshake as lti-launch.mjs, but driven through a headed Chromium so the
// launch lands TOP-LEVEL (first-party) and renders the live AG-UI chat. We
// intercept ltijs's redirect to the platform, mint the platform-signed id_token
// ourselves, then auto-POST it to /lti/launch from the browser -- the state
// cookie set during /login rides along in the browser's own context.
//
// Usage:
//   node scripts/lti-launch-browser.mjs                 (student context)
//   node scripts/lti-launch-browser.mjs --role instructor
//   node scripts/lti-launch-browser.mjs --question "How do I factor x^2-9?"

import { chromium } from 'playwright';
import { SignJWT } from 'jose';
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from './lib/config.mjs';

const { TOOL, ISS, CLIENT_ID, DEPLOYMENT_ID, KID, KEY_PATH, LAUNCH_URI, AUTH_ENDPOINT } = config;

const ROLE_URIS = {
  learner: 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner',
  instructor: 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
};
const PERSONAS = {
  learner: { sub: 'user-learner-1', name: 'Sam Learner', given_name: 'Sam', family_name: 'Learner', email: 'sam.learner@example.edu' },
  instructor: { sub: 'user-instructor-1', name: 'Dr. Ada Instructor', given_name: 'Ada', family_name: 'Instructor', email: 'ada.instructor@example.edu' },
};

function arg(flag, fallback) {
  const a = process.argv.slice(2);
  const i = a.findIndex((x) => x === flag || x.startsWith(`${flag}=`));
  if (i === -1) return fallback;
  return a[i].includes('=') ? a[i].split('=').slice(1).join('=') : a[i + 1] ?? fallback;
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function signIdToken(role, nonce) {
  const persona = PERSONAS[role];
  const key = createPrivateKey(readFileSync(KEY_PATH));
  const now = Math.floor(Date.now() / 1000);
  const claim = (name, value) => [`https://purl.imsglobal.org/spec/lti/claim/${name}`, value];
  return new SignJWT(
    Object.fromEntries([
      claim('message_type', 'LtiResourceLinkRequest'),
      claim('version', '1.3.0'),
      claim('deployment_id', DEPLOYMENT_ID),
      claim('target_link_uri', LAUNCH_URI),
      claim('resource_link', { id: 'rl-hw1', title: 'Homework 1', description: 'Chapter 3 practice set' }),
      claim('roles', [ROLE_URIS[role]]),
      claim('context', {
        id: 'course-cs101', label: 'CS101', title: 'Intro to Computer Science',
        type: ['http://purl.imsglobal.org/vocab/lis/v2/course#CourseOffering'],
      }),
      claim('tool_platform', { guid: 'lti-ri-6426', name: 'Homework Help - ATW' }),
      claim('launch_presentation', { document_target: 'window', return_url: `${ISS}/platforms/6426/returns` }),
      ['name', persona.name], ['given_name', persona.given_name],
      ['family_name', persona.family_name], ['email', persona.email], ['nonce', nonce],
    ]),
  )
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
    .setIssuer(ISS).setAudience(CLIENT_ID).setSubject(persona.sub)
    .setIssuedAt(now).setExpirationTime(now + 600)
    .sign(key);
}

async function main() {
  const role = (arg('--role', 'learner') || 'learner').toLowerCase();
  const question = arg('--question', 'I have a right triangle with legs 3 and 4. How do I find the hypotenuse?');
  const persona = PERSONAS[role] || PERSONAS.learner;

  console.log(`\nOpening a browser and launching an LTI resource as ${role} (${persona.name})...`);

  const browser = await chromium.launch({ headless: false, slowMo: 250 });
  const context = await browser.newContext({ viewport: { width: 900, height: 720 } });
  const page = await context.newPage();

  // Intercept ltijs's redirect to the platform auth endpoint: capture state +
  // nonce and abort (we ARE the platform, so we don't need to hit lti-ri).
  let authUrl = null;
  const isAuth = (url) => url.startsWith(AUTH_ENDPOINT);
  const capture = (url) => { if (!authUrl && isAuth(url)) authUrl = url; };
  context.on('request', (req) => capture(req.url()));
  await context.route((url) => isAuth(url.href), (route) => {
    capture(route.request().url());
    route.abort();
  });

  // Step 1: OIDC login initiation, top-level -> sets the state cookie in-browser.
  const loginQs = new URLSearchParams({
    iss: ISS, login_hint: persona.sub, target_link_uri: LAUNCH_URI,
    client_id: CLIENT_ID, lti_deployment_id: DEPLOYMENT_ID,
  });
  const authReq = context
    .waitForEvent('request', { predicate: (r) => /\/authorizations\/new/.test(r.url()), timeout: 20000 })
    .catch(() => null);
  await page.goto(`${TOOL}/login?${loginQs}`, { waitUntil: 'commit' }).catch(() => {});
  const req = await authReq;
  if (req) capture(req.url());
  if (!authUrl) throw new Error('Did not capture the platform auth redirect from /login.');

  const u = new URL(authUrl.replace(/&amp;/g, '&'));
  const state = u.searchParams.get('state');
  const nonce = u.searchParams.get('nonce');
  const cookies = await context.cookies(TOOL);
  console.log(`  login: state+nonce captured, ${cookies.length} tool cookie(s) in the browser.`);
  if (!state || !nonce) throw new Error('Missing state/nonce in the auth redirect.');

  // Step 2: mint the platform-signed id_token echoing the nonce.
  const idToken = await signIdToken(role, nonce);

  // Step 3: auto-POST the launch from the browser (top-level nav, cookie rides along).
  const formHtml = `<!doctype html><html><body style="font-family:system-ui;padding:2rem;color:#334">
    <p>Submitting LTI launch to the tool&hellip;</p>
    <form id="f" method="POST" action="${escapeAttr(LAUNCH_URI)}">
      <input type="hidden" name="id_token" value="${escapeAttr(idToken)}">
      <input type="hidden" name="state" value="${escapeAttr(state)}">
    </form>
    <script>document.getElementById('f').submit();</script>
  </body></html>`;
  await page.setContent(formHtml, { waitUntil: 'load' });

  if (role === 'instructor') {
    await page.waitForSelector('text=Professor portal', { timeout: 30000 });
    console.log('  launched: professor portal rendered.');
  } else {
    await page.waitForSelector('#input', { timeout: 30000 });
    console.log('  launched: tutor chat rendered. Auto-sending a homework question...');
    await page.fill('#input', question);
    await page.click('#send');
    // Wait for the tutor to start streaming a reply. First hit may be a cold
    // start (agent can scale to zero), so allow generous time.
    await page
      .waitForFunction(() => {
        const b = document.querySelector('.msg.bot');
        return b && b.textContent && b.textContent.trim().length > 0;
      }, { timeout: 150000 })
      .then(async () => {
        await page.waitForTimeout(4000); // let a few more tokens stream in
        const reply = await page.$eval('.msg.bot', (el) => el.textContent).catch(() => '');
        console.log(`\n  Tutor replied (streamed):\n  "${reply.slice(0, 240)}${reply.length > 240 ? '…' : ''}"\n`);
      })
      .catch(() => console.log('  (tutor did not stream within 150s — check the agent)'));
  }

  console.log('Browser is open. Interact with the chat, then close the window to end.');
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  await browser.close().catch(() => {});
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
