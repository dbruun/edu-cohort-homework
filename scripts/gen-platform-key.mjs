// Generates a self-owned LTI platform RSA keypair so we don't depend on lti-ri.
//
// Writes .platform-key.pem (private) and .platform-key.pub.pem (public) at the
// repo root (both gitignored), prints the JWK thumbprint to use as LTI_KID, and
// prints the public PEM to register on the tool as PLATFORM_PUBLIC_KEY.
//
//   node scripts/gen-platform-key.mjs

import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { exportJWK, calculateJwkThumbprint } from 'jose';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsDir);
const privPath = join(repoRoot, '.platform-key.pem');
const pubPath = join(repoRoot, '.platform-key.pub.pem');

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
writeFileSync(privPath, privPem);
writeFileSync(pubPath, pubPem);

const jwk = await exportJWK(createPublicKey(pubPem));
const kid = await calculateJwkThumbprint(jwk, 'sha256');

console.log('Generated self-owned platform keypair:');
console.log(`  private : ${privPath}`);
console.log(`  public  : ${pubPath}`);
console.log(`  kid     : ${kid}`);
console.log('\n1) Put this in scripts/.lti.env:');
console.log(`     LTI_KID=${kid}`);
console.log('\n2) Register the tool with the public key (PLATFORM_PUBLIC_KEY):\n');
console.log(pubPem.trim());
