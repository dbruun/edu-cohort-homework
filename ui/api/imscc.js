const crypto = require('crypto');
const path = require('path');
const unzipper = require('unzipper');

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_MEMBER_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_MEMBERS = 500;
const TEXT_EXTENSIONS = new Set(['.htm', '.html', '.md', '.txt', '.xml']);

function htmlToText(value) {
  const ignored = new Set(['script', 'style']);
  let ignoredDepth = 0;
  let text = '';
  for (const part of value.split(/(<[^>]*>)/)) {
    if (!part.startsWith('<')) {
      if (!ignoredDepth) text += part;
      continue;
    }
    const match = part.match(/^<\s*(\/?)\s*([a-z0-9]+)/i);
    if (!match || !ignored.has(match[2].toLowerCase())) {
      if (!ignoredDepth) text += ' ';
      continue;
    }
    ignoredDepth += match[1] ? -1 : 1;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function xmlToText(value) {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function validMemberName(name) {
  return typeof name === 'string' && !name.includes('\\') && !name.startsWith('/') &&
    !name.split('/').includes('..');
}

async function loadImsccDocuments(buffer, subject) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_ARCHIVE_BYTES) {
    throw new Error('IMSCC archive must be a non-empty file no larger than 50 MB.');
  }
  const directory = await unzipper.Open.buffer(buffer);
  if (directory.files.length > MAX_MEMBERS) throw new Error('IMSCC archive contains too many files.');
  const manifest = directory.files.find((file) => file.path === 'imsmanifest.xml');
  if (!manifest) throw new Error('IMSCC archive does not contain imsmanifest.xml.');

  const manifestText = (await manifest.buffer()).toString('utf8');
  const referenced = new Set([...manifestText.matchAll(/<file\b[^>]*\bhref=["']([^"']+)["']/gi)]
    .map((match) => match[1]));
  let totalBytes = 0;
  const documents = [];

  for (const memberName of referenced) {
    if (!validMemberName(memberName) || !TEXT_EXTENSIONS.has(path.extname(memberName).toLowerCase())) continue;
    const member = directory.files.find((file) => file.path === memberName);
    if (!member || member.type === 'Directory' || member.uncompressedSize > MAX_MEMBER_BYTES) continue;
    totalBytes += member.uncompressedSize;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('IMSCC archive expands beyond the 50 MB limit.');
    const raw = (await member.buffer()).toString('utf8');
    const extension = path.extname(memberName).toLowerCase();
    const content = extension === '.html' || extension === '.htm'
      ? htmlToText(raw)
      : extension === '.xml' ? xmlToText(raw) : raw.replace(/\s+/g, ' ').trim();
    if (!content) continue;
    documents.push({
      id: `imscc-${crypto.createHash('sha256').update(memberName).digest('hex').slice(0, 24)}`,
      title: path.basename(memberName, extension),
      content,
      subject,
      url: `imscc://portal/${encodeURIComponent(memberName)}`
    });
  }
  if (!documents.length) throw new Error('IMSCC archive does not contain manifest-listed text content.');
  return documents;
}

module.exports = { loadImsccDocuments };
