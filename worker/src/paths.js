'use strict';

// Every path in an IMSCC archive is attacker-controlled: the manifest and the
// ZIP central directory both come from an uploaded file. Normalization happens
// once, here, so no other module has to reason about escaping the extraction
// area.

const WINDOWS_DRIVE = /^[a-zA-Z]:/;
const WINDOWS_UNC = /^\\\\/;

// Decoding is required because manifests reference members by URL-encoded href
// while the ZIP central directory stores the literal name.
function decodeHref(href) {
  try {
    return decodeURIComponent(href);
  } catch {
    // A malformed escape is not a valid reference, so keep the literal value
    // and let path validation reject it if it is unsafe.
    return href;
  }
}

function normalizeMemberPath(rawPath) {
  if (typeof rawPath !== 'string') return { error: 'path is not a string' };
  const value = rawPath.trim();
  if (!value) return { error: 'path is empty' };
  if (value.includes('\0')) return { error: 'path contains a null byte' };
  if (WINDOWS_UNC.test(value) || value.includes('\\')) return { error: 'path contains a backslash' };
  if (value.startsWith('/')) return { error: 'path is absolute' };
  if (WINDOWS_DRIVE.test(value)) return { error: 'path contains a drive letter' };

  const segments = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    // Resolving '..' against collected segments would still allow a member to
    // land outside the archive root, so treat it as a rejection instead.
    if (segment === '..') return { error: 'path traverses outside the archive' };
    segments.push(segment);
  }
  if (!segments.length) return { error: 'path resolves to nothing' };

  return { path: segments.join('/') };
}

// Manifest hrefs are relative to the manifest, which sits at the archive root,
// so a resolved reference is just a normalized archive-relative path.
function resolveHref(href) {
  if (typeof href !== 'string') return { error: 'href is not a string' };
  const withoutFragment = href.split('#')[0].split('?')[0];
  if (!withoutFragment.trim()) return { error: 'href is empty' };
  // A manifest may legitimately point at external material; that is not
  // course content this pipeline can extract.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(withoutFragment) || withoutFragment.startsWith('//')) {
    return { error: 'href points at an external location' };
  }
  return normalizeMemberPath(decodeHref(withoutFragment));
}

module.exports = { decodeHref, normalizeMemberPath, resolveHref };
