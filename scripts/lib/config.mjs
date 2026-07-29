// Loads LTI launch config from scripts/.lti.env (gitignored) into process.env,
// then resolves + validates it. Env vars already set take precedence over the
// file, so CI / one-off overrides still work. No secrets live in source.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // scripts/lib
const scriptsDir = dirname(here); // scripts
const envPath = join(scriptsDir, '.lti.env');

if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(
      `Missing required config "${name}".\n` +
        `Set it in scripts/.lti.env (copy scripts/.lti.env.example) or export it as an env var.`,
    );
    process.exit(2);
  }
  return v;
}

const TOOL = required('TOOL_URL').replace(/\/+$/, '');
const ISS = required('LTI_ISS');
const rawKey = process.env.PLATFORM_PRIVATE_KEY || '../.platform-key.pem';

export const config = {
  TOOL,
  ISS,
  CLIENT_ID: required('LTI_CLIENT_ID'),
  DEPLOYMENT_ID: process.env.LTI_DEPLOYMENT_ID || '1',
  KID: required('LTI_KID'),
  AUTH_ENDPOINT: process.env.LTI_AUTH_ENDPOINT || `${ISS}/auth`,
  KEY_PATH: isAbsolute(rawKey) ? rawKey : resolve(scriptsDir, rawKey),
  LAUNCH_URI: `${TOOL}/lti/launch`,
};
