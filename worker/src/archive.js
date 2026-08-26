'use strict';

const unzipper = require('unzipper');
const { normalizeMemberPath } = require('./paths');

const UNIX_HOST_SYSTEM = 3;
const SYMLINK_MODE = 0xa000;
const FILE_TYPE_MASK = 0xf000;
const ENCRYPTED_FLAG = 0x1;
const SUPPORTED_COMPRESSION_METHODS = new Set([0, 8]);

const DEFAULT_LIMITS = {
  maxMembers: 5000,
  maxMemberBytes: 100 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxCompressionRatio: 200
};

function validationError(message) {
  return Object.assign(new Error(message), { validation: true });
}

function securityError(message) {
  return Object.assign(new Error(message), { validation: true, security: true });
}

function isEncrypted(entry) {
  return (Number(entry.flags) & ENCRYPTED_FLAG) === ENCRYPTED_FLAG;
}

function isSymlink(entry) {
  if ((Number(entry.versionMadeBy) >>> 8) !== UNIX_HOST_SYSTEM) return false;
  const mode = Number(entry.externalFileAttributes) >>> 16;
  return (mode & FILE_TYPE_MASK) === SYMLINK_MODE;
}

// Nothing here reads member content: every decision is made from the ZIP
// central directory, so a hostile archive is rejected before it is expanded.
function inspectEntries(entries, overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (entries.length > limits.maxMembers) {
    throw securityError(`Archive contains ${entries.length} members, more than the ${limits.maxMembers} allowed.`);
  }

  const members = new Map();
  const warnings = [];
  const skipped = [];
  let totalUncompressedBytes = 0;

  for (const entry of entries) {
    if (entry.type === 'Directory') continue;

    if (isEncrypted(entry) || !SUPPORTED_COMPRESSION_METHODS.has(Number(entry.compressionMethod))) {
      throw securityError('Archive contains encrypted or unsupported compressed members.');
    }

    const uncompressedSize = Number(entry.uncompressedSize) || 0;
    const compressedSize = Number(entry.compressedSize) || 0;
    if (uncompressedSize > limits.maxMemberBytes) {
      throw securityError(`Archive member '${entry.path}' expands beyond the allowed member size.`);
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
      throw securityError(`Archive member '${entry.path}' has an implausible compression ratio.`);
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > limits.maxTotalBytes) {
      throw securityError('Archive expands beyond the allowed total size.');
    }

    if (isSymlink(entry)) {
      skipped.push({ path: entry.path, reason: 'symbolic link' });
      warnings.push(`Skipped '${entry.path}': symbolic links are not extracted.`);
      continue;
    }

    const normalized = normalizeMemberPath(entry.path);
    if (normalized.error) {
      skipped.push({ path: entry.path, reason: normalized.error });
      warnings.push(`Skipped '${entry.path}': ${normalized.error}.`);
      continue;
    }
    // Two members that normalize to one path make extraction order decide the
    // content, so the later one is ignored rather than silently winning.
    if (members.has(normalized.path)) {
      skipped.push({ path: entry.path, reason: 'duplicate path' });
      warnings.push(`Skipped '${entry.path}': duplicates an earlier member.`);
      continue;
    }
    members.set(normalized.path, entry);
  }

  return { members, warnings, skipped, totalUncompressedBytes, limits };
}

async function openArchive(archivePath, overrides = {}) {
  let directory;
  try {
    // Open.file reads only the central directory and streams members on
    // demand, so a multi-gigabyte archive never enters memory.
    directory = await unzipper.Open.file(archivePath);
  } catch (error) {
    throw validationError(`The upload is not a readable ZIP archive: ${error.message}`);
  }
  return { directory, ...inspectEntries(directory.files, overrides) };
}

async function readMember(entry, maxBytes) {
  const content = await entry.buffer();
  if (content.length > maxBytes) {
    throw securityError(`Archive member '${entry.path}' expanded beyond its declared size.`);
  }
  return content;
}

module.exports = {
  DEFAULT_LIMITS,
  inspectEntries,
  isEncrypted,
  isSymlink,
  openArchive,
  readMember,
  securityError,
  validationError
};
