import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Functions host does not run npm install: whatever is uploaded is what
// runs. Deploying the project directory alone leaves require('@azure/functions')
// unresolvable, the worker registers nothing, and the host reports
// "0 functions found" with no obvious error. This stages a self-contained
// folder with production dependencies already installed.

const labRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const functionsRoot = join(labRoot, '..', 'functions');
const deploymentRoot = join(functionsRoot, '.azd-deploy');

function runNpm(arguments_, cwd, environment = process.env) {
  const executable = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const commandArguments = process.platform === 'win32'
    ? ['/d', '/s', '/c', `npm ${arguments_.join(' ')}`]
    : arguments_;
  const result = spawnSync(executable, commandArguments, {
    cwd,
    env: environment,
    stdio: 'inherit'
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await rm(deploymentRoot, { force: true, recursive: true });
await mkdir(deploymentRoot, { recursive: true });

for (const file of ['host.json', 'package-lock.json']) {
  await cp(join(functionsRoot, file), join(deploymentRoot, file));
}

// The host never runs these scripts, and 'start' would invoke func from a path
// that does not exist on the deployed instance.
const manifest = JSON.parse(await readFile(join(functionsRoot, 'package.json'), 'utf8'));
delete manifest.scripts;
await writeFile(join(deploymentRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// src only: test fixtures have no place on the deployed host.
await cp(join(functionsRoot, 'src'), join(deploymentRoot, 'src'), { recursive: true });

runNpm(
  ['ci', '--omit=dev', '--ignore-scripts'],
  deploymentRoot,
  { ...process.env, NODE_ENV: 'production' }
);

console.log(`Dispatcher deployment package created at ${deploymentRoot}`);
