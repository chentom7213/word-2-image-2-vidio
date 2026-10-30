const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_AHEAD_MS = 2 * 60 * 1000;

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return atob(padded);
}

/** Access-token `exp` in milliseconds. Unreadable tokens have no deadline. */
export function accessTokenExpMs(token: string | null): number | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const parsed = JSON.parse(decodeBase64Url(part)) as { exp?: unknown };
    const exp = Number(parsed.exp);
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return exp * 1000;
  } catch {
    return null;
  }
}

/**
 * Milliseconds until a silent refresh. Uses the token expiry minus the lead
 * time. A missing expiry falls back to a fresh 15-minute token.
 */
export function refreshDelayMs(
  token: string | null,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  aheadMs = DEFAULT_AHEAD_MS,
): number {
  const expMs = accessTokenExpMs(token);
  const deadline = expMs ?? now + ttlMs;
  return Math.max(0, deadline - aheadMs - now);
}
