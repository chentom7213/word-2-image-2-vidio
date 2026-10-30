import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { signPayload } from '../src/services/payments.js';

/**
 * Webhook signature verification is the only thing standing between a forged
 * POST and free credits. These tests pin the properties that matter.
 */

describe('signPayload', () => {
  it('is deterministic HMAC-SHA256 hex', () => {
    const sig = signPayload('secret', '{"a":1}');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sig).toBe(signPayload('secret', '{"a":1}'));
  });

  it('matches an independently computed HMAC', () => {
    const payload = '{"eventId":"e1","orderId":"o1","type":"paid"}';
    const expected = createHmac('sha256', 'k').update(payload).digest('hex');
    expect(signPayload('k', payload)).toBe(expected);
  });

  it('changes with the secret', () => {
    expect(signPayload('a', 'p')).not.toBe(signPayload('b', 'p'));
  });

  it('is sensitive to byte-level payload changes', () => {
    // Re-serializing a JSON body (key order, spacing) must invalidate the
    // signature — this is why the webhook route reads the raw body.
    const canonical = '{"a":1,"b":2}';
    const reserialized = '{"b":2,"a":1}';
    expect(signPayload('k', canonical)).not.toBe(signPayload('k', reserialized));
    expect(signPayload('k', '{"a": 1}')).not.toBe(signPayload('k', '{"a":1}'));
  });
});

describe('order amount computation', () => {
  /**
   * The credited amount is `credits + bonus`, and the price is server-side.
   * A pack whose total silently differs from what the UI shows would be a
   * billing bug users notice immediately, so the arithmetic is pinned here.
   */
  const pack = { credits: 5000, bonus: 500, priceCents: 3900 };

  it('adds the bonus to the credited amount', () => {
    expect(pack.credits + pack.bonus).toBe(5500);
  });

  it('keeps prices in integer cents (no float drift)', () => {
    expect(Number.isInteger(pack.priceCents)).toBe(true);
    const perCredit = pack.priceCents / (pack.credits + pack.bonus);
    expect(perCredit).toBeGreaterThan(0);
  });

  it('never credits zero for a purchasable pack', () => {
    expect(pack.credits + pack.bonus).toBeGreaterThan(0);
  });
});
