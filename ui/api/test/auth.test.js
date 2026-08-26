const test = require('node:test');
const assert = require('node:assert/strict');
const { professorFromHeaders } = require('../auth');

test('reads the signed-in professor from App Service Easy Auth headers', () => {
  assert.deepEqual(professorFromHeaders({
    'x-ms-client-principal-id': 'professor-object-id',
    'x-ms-client-principal-name': 'professor@example.edu',
    'x-ms-client-principal': Buffer.from(JSON.stringify({
      userDetails: 'professor@example.edu',
      claims: [
        { typ: 'oid', val: 'professor-object-id' },
        { typ: 'name', val: 'Professor Ada Lovelace' }
      ]
    })).toString('base64url')
  }), {
    id: 'professor-object-id',
    name: 'Professor Ada Lovelace'
  });
});

test('rejects an identity asserted only by the spoofable id header', () => {
  assert.throws(() => professorFromHeaders({
    'x-ms-client-principal-id': 'professor-object-id',
    'x-ms-client-principal-name': 'professor@example.edu'
  }), /Authentication is required/);
});

test('falls back to the simple identity headers only alongside an encoded principal', () => {
  assert.deepEqual(professorFromHeaders({
    'x-ms-client-principal-id': 'professor-object-id',
    'x-ms-client-principal-name': 'professor@example.edu',
    'x-ms-client-principal': Buffer.from(JSON.stringify({})).toString('base64url')
  }), {
    id: 'professor-object-id',
    name: 'professor@example.edu'
  });
});

test('rejects a principal that is not decodable json', () => {
  assert.throws(() => professorFromHeaders({
    'x-ms-client-principal': 'not-base64-encoded-json'
  }), /Authentication is required/);
});

test('rejects requests without an authenticated principal', () => {
  assert.throws(() => professorFromHeaders({}), /Authentication is required/);
});