export const IDEMPOTENCY_KEY_MAX_LENGTH = 80;
export const IDEMPOTENCY_KEY_TOO_LONG = '幂等键最长 80 字';

/**
 * The column is VARCHAR(80). A longer key must be rejected, not sliced:
 * slicing would make two different keys look like the same submission.
 * Blank and missing headers mean the caller did not send a key.
 */
export function idempotencyKeyFromHeader(raw: unknown): { key: string | null; error: string | null } {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return { key: null, error: null };
  const text = value.trim();
  if (!text) return { key: null, error: null };
  if (text.length > IDEMPOTENCY_KEY_MAX_LENGTH) return { key: null, error: IDEMPOTENCY_KEY_TOO_LONG };
  return { key: text, error: null };
}
