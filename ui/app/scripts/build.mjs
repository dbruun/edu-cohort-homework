import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = join(process.cwd(), 'dist');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), '<!doctype html><html lang="en"><body><h1>Professor portal build complete</h1></body></html>');
console.log('Portal build completed.');
