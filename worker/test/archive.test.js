'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectEntries } = require('../src/archive');

// Every decision under test is made from central-directory metadata, so hostile
// archives are described directly instead of being built on disk.
function entry(overrides = {}) {
  return {
    path: 'wiki_content/page.html',
    type: 'File',
    flags: 0,
    compressionMethod: 8,
    compressedSize: 1000,
    uncompressedSize: 4000,
    versionMadeBy: 0x0314,
    externalFileAttributes: 0x81a4 << 16,
    ...overrides
  };
}

test('accepts an ordinary archive and indexes members by normalized path', () => {
  const result = inspectEntries([
    entry({ path: 'imsmanifest.xml' }),
    entry({ path: './wiki_content//page.html' }),
    entry({ path: 'wiki_content/', type: 'Directory' })
  ]);
  assert.deepEqual([...result.members.keys()], ['imsmanifest.xml', 'wiki_content/page.html']);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.totalUncompressedBytes, 8000);
});

test('stops an archive with too many members before reading any of them', () => {
  const entries = Array.from({ length: 11 }, (_, index) => entry({ path: `page-${index}.html` }));
  assert.throws(() => inspectEntries(entries, { maxMembers: 10 }), (error) => error.security === true);
});

test('stops a zip bomb by compression ratio, member size, and total expansion', () => {
  assert.throws(
    () => inspectEntries([entry({ compressedSize: 1000, uncompressedSize: 1000 * 1000 })]),
    /implausible compression ratio/
  );
  assert.throws(
    () => inspectEntries([entry({ compressedSize: 1000, uncompressedSize: 5000 })], { maxMemberBytes: 4000 }),
    /beyond the allowed member size/
  );
  assert.throws(
    () => inspectEntries(
      [entry({ path: 'a.html' }), entry({ path: 'b.html' })],
      { maxTotalBytes: 5000 }
    ),
    /beyond the allowed total size/
  );
});

test('refuses encrypted and unsupported compression methods outright', () => {
  assert.throws(() => inspectEntries([entry({ flags: 0x1 })]), /encrypted or unsupported/);
  assert.throws(() => inspectEntries([entry({ compressionMethod: 99 })]), /encrypted or unsupported/);
  assert.throws(() => inspectEntries([entry({ flags: 0x1 })]), (error) => error.security === true);
});

test('skips symbolic links, unsafe paths, and duplicates with a recorded reason', () => {
  const result = inspectEntries([
    entry({ path: 'wiki_content/page.html' }),
    entry({ path: './wiki_content/page.html' }),
    entry({ path: '../../etc/passwd' }),
    entry({ path: 'link.html', externalFileAttributes: 0xa1ff << 16 })
  ]);

  assert.deepEqual([...result.members.keys()], ['wiki_content/page.html']);
  assert.deepEqual(result.skipped.map((item) => item.reason).sort(), [
    'duplicate path',
    'path traverses outside the archive',
    'symbolic link'
  ]);
  // A skipped member is reported to the professor, never silently dropped.
  assert.equal(result.warnings.length, 3);
});

test('treats a symlink as a link only when the archive was made on unix', () => {
  const windowsEntry = entry({ path: 'link.html', versionMadeBy: 0x0014, externalFileAttributes: 0xa1ff << 16 });
  assert.deepEqual([...inspectEntries([windowsEntry]).members.keys()], ['link.html']);
});
