import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

await mkdir(new URL('./public/dist/', import.meta.url), { recursive: true });
await build({
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: ['response-renderer.mjs'],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'CoursePilotResponse',
  outfile: 'public/dist/response-renderer.js',
  legalComments: 'linked'
});
for (const file of ['katex.min.css', 'fonts']) {
  await cp(
    new URL(`./node_modules/katex/dist/${file}`, import.meta.url),
    new URL(`./public/dist/${file}`, import.meta.url),
    { recursive: true }
  );
}
