'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseManifest } = require('../src/manifest');

const packageTitleManifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="canvas.course.export.chem" xmlns="http://www.imsglobal.org/xsd/imsccv1p1/imscp_v1p1"
          xmlns:imsmd="http://ltsc.ieee.org/xsd/imsccv1p1/LOM/resource">
  <metadata>
    <schema>IMS Common Cartridge</schema>
    <imsmd:lom><imsmd:general><imsmd:title><imsmd:string language="en-US">Chemistry 201</imsmd:string></imsmd:title></imsmd:general></imsmd:lom>
  </metadata>
  <organizations default="course">
    <organization identifier="course"><title>Ignored Organization Title</title></organization>
  </organizations>
  <resources>
    <resource identifier="page-1" type="webcontent" href="wiki_content/intro.html">
      <file href="wiki_content/intro.html"/>
    </resource>
  </resources>
</manifest>`;

const organizationTitleManifest = `<?xml version="1.0"?>
<manifest identifier="canvas.course.export.bio">
  <metadata><schema>IMS Common Cartridge</schema></metadata>
  <organizations default="course">
    <organization identifier="other"><title>Wrong Course</title></organization>
    <organization identifier="course"><title>Biology 101</title></organization>
  </organizations>
  <resources>
    <resource identifier="page-1" type="webcontent" href="wiki_content/intro.html"/>
  </resources>
</manifest>`;

test('prefers the package metadata title over the organization title', () => {
  const manifest = parseManifest(packageTitleManifest);
  assert.equal(manifest.courseName, 'Chemistry 201');
  assert.equal(manifest.courseNameSource, 'manifest.metadata.title');
  assert.equal(manifest.cartridgeIdentifier, 'canvas.course.export.chem');
});

test('falls back to the default organization title when no package title exists', () => {
  const manifest = parseManifest(organizationTitleManifest);
  assert.equal(manifest.courseName, 'Biology 101');
  assert.equal(manifest.courseNameSource, 'manifest.organization.title');
});

test('collects each referenced member exactly once, in manifest order', () => {
  const manifest = parseManifest(`<manifest identifier="c">
    <organizations><organization><title>Course</title></organization></organizations>
    <resources>
      <resource identifier="r1" type="webcontent" href="a.html"><file href="a.html"/><file href="b.html"/></resource>
      <resource identifier="r2" type="webcontent"><file href="a.html"/></resource>
    </resources>
  </manifest>`);
  assert.deepEqual(manifest.references.map((reference) => reference.path), ['a.html', 'b.html']);
  assert.equal(manifest.references[0].resourceIdentifier, 'r1');
});

test('warns about unsafe manifest references instead of resolving them', () => {
  const manifest = parseManifest(`<manifest identifier="c">
    <organizations><organization><title>Course</title></organization></organizations>
    <resources>
      <resource identifier="r1" type="webcontent"><file href="../../etc/passwd"/><file href="ok.html"/></resource>
    </resources>
  </manifest>`);
  assert.deepEqual(manifest.references.map((reference) => reference.path), ['ok.html']);
  assert.match(manifest.warnings.join(' '), /etc\/passwd/);
});

test('rejects manifests that cannot name or populate a course', () => {
  assert.throws(() => parseManifest(''), /empty/);
  assert.throws(() => parseManifest('<html><body>not a manifest</body></html>'), /no <manifest> element/);
  assert.throws(
    () => parseManifest('<manifest identifier="c"><resources><resource href="a.html"/></resources></manifest>'),
    /no package metadata title and no organization title/
  );
  assert.throws(
    () => parseManifest('<manifest identifier="c"><organizations><organization><title>Course</title></organization></organizations><resources/></manifest>'),
    /references no files/
  );
});

test('marks manifest problems as validation failures so the archive is quarantined', () => {
  assert.throws(() => parseManifest('<html/>'), (error) => error.validation === true);
});
