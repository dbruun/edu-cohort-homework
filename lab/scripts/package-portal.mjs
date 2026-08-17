import { access, cp, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const labRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = join(labRoot, '..', 'ui');
const deploymentRoot = join(uiRoot, '.azd-deploy');
const appDist = join(uiRoot, 'app', 'dist');

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

runNpm(['--prefix', 'app', 'ci', '--ignore-scripts'], uiRoot);
runNpm(['--prefix', 'app', 'run', 'build'], uiRoot);
await access(appDist);
await rm(deploymentRoot, { force: true, recursive: true });
await mkdir(join(deploymentRoot, 'api'), { recursive: true });
await mkdir(join(deploymentRoot, 'app'), { recursive: true });

for (const file of ['package.json', 'package-lock.json', 'server.js']) {
  await cp(join(uiRoot, file), join(deploymentRoot, file));
}

for (const file of ['auth.js', 'documents.js', 'imscc.js', 'policy.js']) {
  await cp(join(uiRoot, 'api', file), join(deploymentRoot, 'api', file));
}

await cp(appDist, join(deploymentRoot, 'app', 'dist'), { recursive: true });

runNpm(
  ['ci', '--omit=dev', '--ignore-scripts'],
  deploymentRoot,
  { ...process.env, NODE_ENV: 'production' }
);

console.log(`Portal deployment package created at ${deploymentRoot}`);