'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMemberPath, resolveHref } = require('../src/paths');

test('normalizes ordinary archive-relative member paths', () => {
  assert.deepEqual(normalizeMemberPath('wiki_content/week_1.html'), { path: 'wiki_content/week_1.html' });
  assert.deepEqual(normalizeMemberPath('./wiki_content//week_1.html'), { path: 'wiki_content/week_1.html' });
  assert.deepEqual(normalizeMemberPath('  wiki_content/week_1.html  '), { path: 'wiki_content/week_1.html' });
});

test('refuses every member path that could escape the extraction area', () => {
  const hostile = [
    '../../etc/passwd',
    'wiki_content/../../etc/passwd',
    '/etc/passwd',
    'C:/Windows/system32/config',
    'C:\\Windows\\system32',
    '\\\\server\\share\\file',
    'wiki_content\\week_1.html',
    'wiki\0content.html',
    '',
    '   ',
    './',
    42,
    null
  ];
  for (const value of hostile) {
    const result = normalizeMemberPath(value);
    assert.ok(result.error, `${JSON.stringify(value)} must be rejected`);
    assert.equal(result.path, undefined);
  }
});

test('resolves manifest hrefs, including percent-encoded names', () => {
  assert.deepEqual(resolveHref('wiki_content/week%201.html'), { path: 'wiki_content/week 1.html' });
  assert.deepEqual(resolveHref('wiki_content/page.html#section'), { path: 'wiki_content/page.html' });
  assert.deepEqual(resolveHref('wiki_content/page.html?v=2'), { path: 'wiki_content/page.html' });
});

test('refuses hrefs that leave the archive', () => {
  for (const href of ['https://example.com/page.html', '//example.com/page.html', '../secrets.html', '/etc/passwd', '#only-a-fragment', '']) {
    assert.ok(resolveHref(href).error, `${href} must be rejected`);
  }
});
