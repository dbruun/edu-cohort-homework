function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function professorFromHeaders(headers) {
  const id = headerValue(headers, 'x-ms-client-principal-id');
  const name = headerValue(headers, 'x-ms-client-principal-name');
  if (id) return { id, name: name || 'Professor' };

  const encoded = headerValue(headers, 'x-ms-client-principal');
  if (!encoded) throw new Error('Authentication is required.');
  const principal = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const roles = principal.userRoles || [];
  if (process.env.REQUIRE_PROFESSOR_ROLE === 'true' && !roles.includes('professor')) {
    throw new Error('Professor access is required.');
  }
  const claims = Object.fromEntries((principal.claims || []).map((claim) => [claim.typ, claim.val]));
  const principalId = claims.oid || claims.sub || principal.userId;
  if (!principalId) throw new Error('Authenticated identity has no stable identifier.');
  return { id: principalId, name: claims.name || principal.userDetails || 'Professor' };
}

module.exports = { professorFromHeaders };