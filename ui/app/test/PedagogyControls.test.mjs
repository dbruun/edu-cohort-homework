import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { outputFiles } = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/PedagogyControls.jsx', import.meta.url))],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  write: false
});
const module = { exports: {} };
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url) });
const PedagogyControls = module.exports.default;
const PedagogyGuide = module.exports.PedagogyGuide;

function controls(helpLevel, citationsRequired = true) {
  return createElement(PedagogyControls, { helpLevel, citationsRequired, onChange() {} });
}

test('the always-visible guide presents all help styles and citations in a labelled panel', () => {
  const html = renderToStaticMarkup(createElement(PedagogyGuide));
  assert.match(html, /^<section class="portal-panel pedagogy-guide" aria-labelledby="([^"]+)">/);
  const headingId = html.match(/aria-labelledby="([^"]+)"/)[1];
  assert.ok(html.includes(`<h2 id="${headingId}">Pedagogy guide</h2>`));
  for (const heading of ['Guided', 'Worked example', 'Full solution', 'Require citations']) {
    assert.ok(html.includes(`<h3>${heading}</h3>`));
  }
  assert.ok(html.includes('without giving the original final answer'));
  assert.ok(html.includes('different, similar example in full'));
  assert.ok(html.includes('provides the final answer'));
  assert.ok(html.includes('citations are optional, not prohibited'));
  assert.ok(!html.includes('<details'));
});

test('each help style explains the selected behavior beneath the selector', () => {
  const expectedDescriptions = {
    guided: 'pauses for their contribution without giving the original final answer',
    worked_example: 'different, similar example in full',
    full_solution: 'provides the final answer'
  };
  for (const [value, description] of Object.entries(expectedDescriptions)) {
    const html = renderToStaticMarkup(controls(value));
    assert.match(html, new RegExp(`<option value="${value}" selected=""`));
    assert.ok(html.includes(description));
    assert.equal((html.match(/class="control-description"/g) || []).length, 2);
    for (const [otherValue, otherDescription] of Object.entries(expectedDescriptions)) {
      if (otherValue !== value) assert.ok(!html.includes(otherDescription));
    }
  }
});

test('Create custom help style opens a descriptively labelled dialog without adding a category', () => {
  const html = renderToStaticMarkup(createElement(PedagogyGuide));
  assert.match(html, /<button type="button">Create custom help style<\/button>/);
  const dialogHeadingId = html.match(/<dialog[^>]+aria-labelledby="([^"]+)"/)[1];
  assert.ok(html.includes(`<h2 id="${dialogHeadingId}">Custom help style</h2>`));
  assert.ok(html.includes('<form method="dialog">'));
  assert.match(html, /<label>How should the tutor help students\?<textarea name="category" rows="7" autofocus=""><\/textarea><\/label>/);
  assert.ok(html.includes('<button type="submit" value="save" class="primary">Save help style</button>'));
  assert.ok(html.includes('<button type="submit" value="cancel">Cancel</button>'));
  assert.equal((html.match(/class="pedagogy-guide-style"/g) || []).length, 3);
  assert.ok(!html.includes('not available'));
  assert.ok(!html.includes('placeholder'));
});

test('citation guidance explains both states without changing the saved checkbox value', () => {
  for (const enabled of [true, false]) {
    const html = renderToStaticMarkup(controls('guided', enabled));
    assert.equal(html.includes('checked=""'), enabled);
    assert.ok(html.includes('must cite course materials'));
    assert.ok(html.includes('citations are optional, not prohibited'));
  }
});

test('multiple groups and defaults have unique, correctly associated accessible descriptions', () => {
  const html = renderToStaticMarkup(createElement('div', null, controls('guided'), controls('worked_example'), controls('full_solution')));
  const ids = [...html.matchAll(/<p id="([^"]+)"/g)].map((match) => match[1]);
  const references = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(references, ids);
});
