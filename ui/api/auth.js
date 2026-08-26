function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// Every identity here comes from headers App Service Easy Auth injects after it
// strips any the client sent. The encoded principal is therefore required: the
// bare x-ms-client-principal-id header is a single value an anonymous caller
// could set for themselves if Easy Auth were ever absent, so accepting it alone
// would make a misconfigured deployment fail open rather than shut.
function professorFromHeaders(headers) {
  const encoded = headerValue(headers, 'x-ms-client-principal');
  if (!encoded) throw new Error('Authentication is required.');

  let principal;
  try {
    principal = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Authentication is required.');
  }
  if (!principal || typeof principal !== 'object') throw new Error('Authentication is required.');

  const roles = principal.userRoles || [];
  if (process.env.REQUIRE_PROFESSOR_ROLE === 'true' && !roles.includes('professor')) {
    throw new Error('Professor access is required.');
  }
  const claims = Object.fromEntries((principal.claims || []).map((claim) => [claim.typ, claim.val]));
  const principalId = claims.oid || claims.sub || principal.userId
    || headerValue(headers, 'x-ms-client-principal-id');
  if (!principalId) throw new Error('Authenticated identity has no stable identifier.');
  const name = claims.name || principal.userDetails
    || headerValue(headers, 'x-ms-client-principal-name') || 'Professor';
  return { id: principalId, name };
}

module.exports = { professorFromHeaders };