// Headless LTI 1.3 launch driver.
//
// Impersonates the lti-ri platform (6426) to run a full LTI 1.3 resource-link
// launch against the live tool WITHOUT a browser. Because a script keeps its
// own cookie jar, it carries ltijs's state cookie through the handshake in a
// single first-party context -- which is exactly what a browser can't do in
// the LMS iframe (the MISSING_VALIDATION_COOKIE problem). We sign the id_token
// with lti-ri's platform private key, so the tool validates it against the
// JWKS it already trusts (PLATFORM_KEYSET_ENDPOINT) -- no hosting required.
//
// Usage:
//   node scripts/lti-launch.mjs --role learner
//   node scripts/lti-launch.mjs --role instructor
//
// Env overrides: TOOL_URL, LTI_CLIENT_ID, LTI_DEPLOYMENT_ID, LTI_KID, LTI_RI_KEY

import { SignJWT } from 'jose';
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from './lib/config.mjs';

const { TOOL, ISS, CLIENT_ID, DEPLOYMENT_ID, KID, KEY_PATH, LAUNCH_URI } = config;

// --- CLI -------------------------------------------------------------------
function parseRole() {
  const a = process.argv.slice(2);
  const i = a.findIndex((x) => x === '--role' || x.startsWith('--role='));
  let v = 'learner';
  if (i !== -1) v = a[i].includes('=') ? a[i].split('=')[1] : a[i + 1];
  v = (v || 'learner').toLowerCase();
  if (v !== 'learner' && v !== 'instructor') {
    console.error(`Unknown role "${v}". Use --role learner | instructor.`);
    process.exit(2);
  }
  return v;
}

const ROLE_URIS = {
  learner: 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner',
  instructor: 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
};

const PERSONAS = {
  learner: { sub: 'user-learner-1', name: 'Sam Learner', given_name: 'Sam', family_name: 'Learner', email: 'sam.learner@example.edu' },
  instructor: { sub: 'user-instructor-1', name: 'Dr. Ada Instructor', given_name: 'Ada', family_name: 'Instructor', email: 'ada.instructor@example.edu' },
};

// --- cookie jar ------------------------------------------------------------
function absorb(res, jar) {
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}
function cookieHeader(jar) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Follow same-origin redirects with GET, replaying the cookie jar each hop.
async function fetchFollow(url, opts, jar, maxHops = 6) {
  let current = url;
  let method = opts.method || 'GET';
  let body = opts.body;
  const headers = { ...(opts.headers || {}) };
  for (let hop = 0; hop < maxHops; hop++) {
    headers.Cookie = cookieHeader(jar);
    const res = await fetch(current, { method, body, headers, redirect: 'manual' });
    absorb(res, jar);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      method = 'GET';
      body = undefined;
      delete headers['Content-Type'];
      continue;
    }
    return res;
  }
  throw new Error('too many redirects following the launch');
}

async function main() {
  const role = parseRole();
  const persona = PERSONAS[role];
  const jar = new Map();

  console.log(`\nLTI 1.3 headless launch  ->  ${TOOL}`);
  console.log(`  role      : ${role}`);
  console.log(`  platform  : ${ISS} (client_id ${CLIENT_ID}, deployment ${DEPLOYMENT_ID})`);
  console.log(`  user      : ${persona.name} <${persona.email}>`);

  // 1) OIDC third-party login initiation. ltijs replies 302 -> platform auth
  //    endpoint with state + nonce, and sets the validation cookie.
  const loginQs = new URLSearchParams({
    iss: ISS,
    login_hint: persona.sub,
    target_link_uri: LAUNCH_URI,
    client_id: CLIENT_ID,
    lti_deployment_id: DEPLOYMENT_ID,
  });
  const loginRes = await fetch(`${TOOL}/login?${loginQs}`, { redirect: 'manual' });
  absorb(loginRes, jar);

  let location = loginRes.headers.get('location');
  if (!location) {
    const bodyText = await loginRes.text();
    const m = bodyText.match(/https?:\/\/[^"'\s]*authorizations\/new[^"'\s]*/);
    location = m && m[0];
  }
  if (!location) {
    console.error(`FAIL: /login did not return an auth redirect (HTTP ${loginRes.status}).`);
    process.exit(1);
  }
  const locUrl = new URL(location.replace(/&amp;/g, '&'));
  const state = locUrl.searchParams.get('state');
  const nonce = locUrl.searchParams.get('nonce');
  if (!state || !nonce) {
    console.error('FAIL: could not extract state/nonce from the auth redirect.');
    console.error(`  location: ${location}`);
    process.exit(1);
  }
  console.log(`  login     : HTTP ${loginRes.status}, state+nonce captured, ${jar.size} cookie(s)`);

  // 2) Mint the platform-signed id_token echoing ltijs's nonce.
  const key = createPrivateKey(readFileSync(KEY_PATH));
  const now = Math.floor(Date.now() / 1000);
  const claim = (name, value) => [`https://purl.imsglobal.org/spec/lti/claim/${name}`, value];
  const idToken = await new SignJWT(
    Object.fromEntries([
      claim('message_type', 'LtiResourceLinkRequest'),
      claim('version', '1.3.0'),
      claim('deployment_id', DEPLOYMENT_ID),
      claim('target_link_uri', LAUNCH_URI),
      claim('resource_link', { id: 'rl-hw1', title: 'Homework 1', description: 'Chapter 3 practice set' }),
      claim('roles', [ROLE_URIS[role]]),
      claim('context', {
        id: 'course-cs101',
        label: 'CS101',
        title: 'Intro to Computer Science',
        type: ['http://purl.imsglobal.org/vocab/lis/v2/course#CourseOffering'],
      }),
      claim('tool_platform', { guid: 'lti-ri-6426', name: 'Homework Help - ATW' }),
      claim('launch_presentation', { document_target: 'window', return_url: `${ISS}/platforms/6426/returns` }),
      ['name', persona.name],
      ['given_name', persona.given_name],
      ['family_name', persona.family_name],
      ['email', persona.email],
      ['nonce', nonce],
    ]),
  )
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
    .setIssuer(ISS)
    .setAudience(CLIENT_ID)
    .setSubject(persona.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(key);

  // 3) Deliver the launch to the tool (form_post) with the cookie jar.
  const launchRes = await fetchFollow(
    LAUNCH_URI,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, state }).toString(),
    },
    jar,
  );
  const body = await launchRes.text();
  console.log(`  launch    : HTTP ${launchRes.status}, ${body.length} bytes returned\n`);

  // --- assertions ----------------------------------------------------------
  const has = (s) => body.includes(s);
  let pass = false;
  const checks = [];
  if (launchRes.status === 200) {
    if (role === 'learner') {
      checks.push(['renders tutor chat page', has('<title>Homework Tutor</title>')]);
      checks.push(['wires the agent URL', has('/agent') || has('agentUrl')]);
      checks.push(['greets the student by name', has(persona.given_name)]);
    } else {
      checks.push(['renders professor portal', has('Professor portal')]);
      checks.push(['identifies instructor launch', has('instructor')]);
      checks.push(['passes course context', has('course-cs101')]);
      checks.push(['passes deployment id', has('>1<') || has('<code>1</code>')]);
    }
    pass = checks.every(([, ok]) => ok);
  }

  for (const [label, ok] of checks) console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log('');
  if (pass) {
    console.log(`RESULT: PASS  --  LTI ${role} launch validated and routed to the correct branch.`);
    process.exit(0);
  }
  console.log(`RESULT: FAIL  --  HTTP ${launchRes.status}. First 600 chars of response:`);
  console.log(body.slice(0, 600));
  process.exit(1);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
