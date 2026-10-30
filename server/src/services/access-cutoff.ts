/**
 * Access tokens are stateless. A user-wide cutoff makes every token issued
 * before "log out everywhere" or an account suspension fail on the next request.
 * API keys are not JWTs and do not use this cutoff.
 */

/** True when this access token was issued at or before the cutoff. */
export function accessIssuedBeforeCutoff(iat: number | undefined, cutoff: unknown): boolean {
  const cutoffMs = parseCutoff(cutoff);
  if (cutoffMs == null) return false;
  if (iat == null || !Number.isFinite(iat)) return true;
  return iat * 1000 <= cutoffMs;
}

function parseCutoff(cutoff: unknown): number | null {
  if (cutoff == null || cutoff === '') return null;
  if (cutoff instanceof Date) {
    const ms = cutoff.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const text = String(cutoff).trim();
  if (!text) return null;
  const iso = text.includes('T') ? text : text.replace(' ', 'T');
  const withZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}
