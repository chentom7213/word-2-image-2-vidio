const SECRET_QUERY =
  /^(token|access_token|refresh_token|id_token|code|state|sig|s|e|signature|key|password|client_secret|api_key)$/i;

function queryName(pair: string): string {
  const raw = pair.split('=')[0] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Strips credentials from a URL before it can reach any log sink. */
export function redactUrl(url: string): string {
  const hashAt = url.indexOf('#');
  const withoutHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  if (!withoutHash.includes('?')) return url;
  const queryAt = withoutHash.indexOf('?');
  const path = withoutHash.slice(0, queryAt);
  const query = withoutHash.slice(queryAt + 1);
  const cleaned = query
    .split('&')
    .map((pair) => (pair && SECRET_QUERY.test(queryName(pair)) ? `${pair.split('=')[0]}=***` : pair))
    .join('&');
  return `${path}?${cleaned}${hash}`;
}
