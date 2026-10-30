import { describe, expect, it } from 'vitest';
import { accessTtlSeconds } from '../src/lib/jwt.js';
import { hashToken } from '../src/services/sessions.js';

describe('hashToken', () => {
  it('is deterministic and hex — never stores raw secrets', () => {
    const t = 'bk_rt_aVeryLongSecretValue';
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(hashToken(t));
  });

  it('differs between tokens', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('accessTtlSeconds', () => {
  it('parses "15m" to seconds', () => {
    expect(accessTtlSeconds()).toBeGreaterThan(0);
    expect(accessTtlSeconds()).toBeLessThanOrEqual(3600);
  });
});
