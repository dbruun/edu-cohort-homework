import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, '.azd-deploy');
await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'coursepilot'), { recursive: true });
await mkdir(join(output, 'ui', 'api'), { recursive: true });
for (const file of ['server.js', 'agent.js', 'policy-cache.js', 'public']) {
  await cp(join(root, file), join(output, 'coursepilot', file), { recursive: true });
}
await cp(join(root, '..', 'ui', 'api', 'auth.js'), join(output, 'ui', 'api', 'auth.js'));
await cp(join(root, '..', 'ui', 'api', 'policy.js'), join(output, 'ui', 'api', 'policy.js'));
await cp(join(root, 'package-lock.json'), join(output, 'package-lock.json'));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
manifest.scripts = { start: 'node coursepilot/server.js' };
await writeFile(join(output, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log('CoursePilot deployment package is ready.');
