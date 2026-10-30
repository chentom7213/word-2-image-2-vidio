/** Headers for a response the client reached over `protocol`. HSTS stays off plain HTTP. */
export function transportHeaders(protocol: string): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
  if (protocol === 'https') headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}
