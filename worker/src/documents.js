'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const DEFAULT_MAX_CHUNK_CHARACTERS = 2000;
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function readHtmlTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? normalizeWhitespace(decodeEntities(match[1])) : '';
}

// Script and style bodies are markup, not course content, so they are dropped
// rather than flattened into the text.
function markupToText(markup, { dropElements = ['script', 'style'] } = {}) {
  const dropped = new Set(dropElements);
  let depth = 0;
  let text = '';
  for (const part of markup.split(/(<!--[\s\S]*?-->|<[^>]*>)/)) {
    if (part.startsWith('<!--')) continue;
    if (!part.startsWith('<')) {
      if (!depth) text += part;
      continue;
    }
    const tag = part.match(/^<\s*(\/?)\s*([a-z0-9:_-]+)/i);
    if (!tag) continue;
    const name = tag[2].toLowerCase();
    if (!dropped.has(name)) {
      // A tag boundary is a word boundary; without this, adjacent elements
      // would run their text together.
      if (!depth) text += ' ';
      continue;
    }
    if (tag[1]) depth = Math.max(0, depth - 1);
    else if (!part.endsWith('/>')) depth += 1;
  }
  return normalizeWhitespace(decodeEntities(text));
}

function toText(sourcePath, raw) {
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension === '.html' || extension === '.htm') {
    return { title: readHtmlTitle(raw), text: markupToText(raw) };
  }
  if (extension === '.xml') return { title: '', text: markupToText(raw) };
  return { title: '', text: normalizeWhitespace(raw) };
}

// Chunks are split on whitespace so a chunk never ends mid-word, and never
// overlap so the same sentence cannot be retrieved twice.
function chunkText(text, maxCharacters = DEFAULT_MAX_CHUNK_CHARACTERS) {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error('maxCharacters must be a positive integer.');
  }
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];
  if (normalized.length <= maxCharacters) return [normalized];

  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    if (normalized.length - start <= maxCharacters) {
      chunks.push(normalized.slice(start));
      break;
    }
    const window = normalized.slice(start, start + maxCharacters + 1);
    const boundary = window.lastIndexOf(' ');
    // A single word longer than the limit has no boundary to split on, so it
    // is cut at the limit rather than dropped.
    const end = boundary > 0 ? start + boundary : start + maxCharacters;
    chunks.push(normalized.slice(start, end).trim());
    start = boundary > 0 ? end + 1 : end;
  }
  return chunks.filter(Boolean);
}

// Search keys must stay stable across re-imports of the same content and must
// never collide between professors, imports, members, or chunks.
function documentId({ professorId, importId, sourcePath, chunkNumber }) {
  const digest = crypto.createHash('sha256')
    .update([professorId, importId, sourcePath, chunkNumber].join('\u0000'))
    .digest('hex');
  return `doc-${digest}`;
}

function buildDocuments({
  professorId,
  importId,
  courseName,
  sourcePath,
  resourceIdentifier,
  raw,
  importedAt,
  maxChunkCharacters = DEFAULT_MAX_CHUNK_CHARACTERS
}) {
  const { title, text } = toText(sourcePath, raw);
  const chunks = chunkText(text, maxChunkCharacters);
  const documentTitle = title || path.basename(sourcePath, path.extname(sourcePath));
  return chunks.map((content, index) => ({
    id: documentId({ professorId, importId, sourcePath, chunkNumber: index }),
    professorId,
    importId,
    courseName,
    title: documentTitle,
    content,
    sourcePath,
    resourceIdentifier,
    chunkNumber: index,
    chunkCount: chunks.length,
    contentHash: crypto.createHash('sha256').update(content).digest('hex'),
    importedAt,
    isActive: false
  }));
}

module.exports = {
  DEFAULT_MAX_CHUNK_CHARACTERS,
  buildDocuments,
  chunkText,
  decodeEntities,
  documentId,
  markupToText,
  normalizeWhitespace,
  readHtmlTitle,
  toText
};
