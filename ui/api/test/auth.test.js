const test = require('node:test');
const assert = require('node:assert/strict');
const { professorFromHeaders } = require('../auth');

test('reads the signed-in professor from App Service Easy Auth headers', () => {
  assert.deepEqual(professorFromHeaders({
    'x-ms-client-principal-id': 'professor-object-id',
    'x-ms-client-principal-name': 'professor@example.edu'
  }), {
    id: 'professor-object-id',
    name: 'professor@example.edu'
  });
});

test('rejects requests without an authenticated principal', () => {
  assert.throws(() => professorFromHeaders({}), /Authentication is required/);
});