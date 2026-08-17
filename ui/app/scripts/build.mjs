import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const outDir = join(process.cwd(), 'dist');
mkdirSync(outDir, { recursive: true });
cpSync('index.html', join(outDir, 'index.html'));
cpSync('../staticwebapp.config.json', join(outDir, 'staticwebapp.config.json'));
await build({ bundle: true, entryPoints: ['src/main.jsx'], format: 'esm', outfile: join(outDir, 'app.js'), jsx: 'automatic' });
console.log('Portal build completed.');
