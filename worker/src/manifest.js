'use strict';

const { XMLParser } = require('fast-xml-parser');
const { resolveHref } = require('./paths');

// Namespace prefixes vary by cartridge version (imsmd:, lomimscc:, none), so
// they are removed rather than matched.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true
});

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// A title may be plain text, an IMS <string>, or a legacy <langstring>, and any
// of those may carry attributes alongside the text.
function readTitle(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node !== 'object') return '';
  for (const key of ['string', 'langstring', '#text']) {
    const found = readTitle(Array.isArray(node[key]) ? node[key][0] : node[key]);
    if (found) return found;
  }
  return '';
}

function readCourseName(manifest) {
  const packageTitle = readTitle(manifest?.metadata?.lom?.general?.title);
  if (packageTitle) return { courseName: packageTitle, courseNameSource: 'manifest.metadata.title' };

  // Compatibility fallback only: most Canvas exports carry no package title.
  const organizations = manifest?.organizations;
  const candidates = toArray(organizations?.organization);
  const preferred = candidates.find((organization) => organization?.['@identifier'] &&
    organization['@identifier'] === organizations?.['@default']) || candidates[0];
  const organizationTitle = readTitle(preferred?.title);
  if (organizationTitle) return { courseName: organizationTitle, courseNameSource: 'manifest.organization.title' };

  return { courseName: '', courseNameSource: '' };
}

function readResources(manifest, warnings) {
  const references = [];
  const seen = new Set();
  for (const resource of toArray(manifest?.resources?.resource)) {
    const resourceIdentifier = resource?.['@identifier'] || '';
    const resourceType = resource?.['@type'] || '';
    // A resource may declare its entry point with href and repeat it in a
    // <file> element, so both are collected and de-duplicated.
    const hrefs = [resource?.['@href'], ...toArray(resource?.file).map((file) => file?.['@href'])];
    for (const href of hrefs) {
      if (!href) continue;
      const resolved = resolveHref(href);
      if (resolved.error) {
        warnings.push(`Skipped manifest reference '${href}': ${resolved.error}.`);
        continue;
      }
      // The same member is frequently referenced by several resources; it must
      // only ever produce one document.
      if (seen.has(resolved.path)) continue;
      seen.add(resolved.path);
      references.push({ path: resolved.path, resourceIdentifier, resourceType });
    }
  }
  return references;
}

function parseManifest(xml) {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw Object.assign(new Error('imsmanifest.xml is empty.'), { validation: true });
  }

  let document;
  try {
    document = parser.parse(xml);
  } catch (error) {
    throw Object.assign(new Error(`imsmanifest.xml is not valid XML: ${error.message}`), { validation: true });
  }

  const manifest = document?.manifest;
  if (!manifest || typeof manifest !== 'object') {
    throw Object.assign(new Error('imsmanifest.xml has no <manifest> element.'), { validation: true });
  }

  const warnings = [];
  const { courseName, courseNameSource } = readCourseName(manifest);
  if (!courseName) {
    throw Object.assign(
      new Error('imsmanifest.xml has no package metadata title and no organization title.'),
      { validation: true }
    );
  }

  const references = readResources(manifest, warnings);
  if (!references.length) {
    throw Object.assign(new Error('imsmanifest.xml references no files.'), { validation: true });
  }

  return {
    courseName,
    courseNameSource,
    cartridgeIdentifier: manifest['@identifier'] || '',
    references,
    warnings
  };
}

module.exports = { parseManifest, readCourseName, readTitle, toArray };
