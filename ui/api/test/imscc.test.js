const test = require('node:test');
const assert = require('node:assert/strict');
const { loadImsccDocuments } = require('../imscc');

const archive = Buffer.from(
  'UEsDBBQAAAAAALa7BF3IIgFcYQAAAGEAAAAPAAAAaW1zbWFuaWZlc3QueG1sPG1hbmlmZXN0PjxyZXNvdXJjZXM+PHJlc291cmNlPjxmaWxlIGhyZWY9InBhZ2VzL3dlZWstMS5odG1sIi8+PC9yZXNvdXJjZT48L3Jlc291cmNlcz48L21hbmlmZXN0PlBLAwQUAAAAAAC2uwRduVKAWDsAAAA7AAAAEQAAAHBhZ2VzL3dlZWstMS5odG1sPGgxPldlZWsgMTwvaDE+PHA+U3R1ZHkgY2VsbHMuPC9wPjxzY3JpcHQ+aWdub3JlKCk8L3NjcmlwdD5QSwECFAMUAAAAAAC2uwRdyCIBXGEAAABhAAAADwAAAAAAAAAAAAAAgAEAAAAAaW1zbWFuaWZlc3QueG1sUEsBAhQDFAAAAAAAtrsEXblSgFg7AAAAOwAAABEAAAAAAAAAAAAAAIABjgAAAHBhZ2VzL3dlZWstMS5odG1sUEsFBgAAAAACAAIAfAAAAPgAAAAAAA==',
  'base64'
);

test('imports manifest-listed Canvas HTML as course content', async () => {
  const documents = await loadImsccDocuments(archive, 'Biology 101');

  assert.equal(documents.length, 1);
  assert.equal(documents[0].subject, 'Biology 101');
  assert.equal(documents[0].content, 'Week 1 Study cells.');
  assert.match(documents[0].url, /pages%2Fweek-1\.html$/);
});
