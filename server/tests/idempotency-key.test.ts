import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_KEY_TOO_LONG, idempotencyKeyFromHeader } from '../src/lib/idempotency-key.js';

describe('idempotencyKeyFromHeader', () => {
  it('刚好 80 字原样使用', () => {
    const key = 'k'.repeat(80);
    expect(idempotencyKeyFromHeader(`  ${key}  `)).toEqual({ key, error: null });
  });

  it('超过 80 字拒绝，不截断', () => {
    const raw = `${'a'.repeat(80)}b`;
    expect(idempotencyKeyFromHeader(raw)).toEqual({ key: null, error: IDEMPOTENCY_KEY_TOO_LONG });
    expect(IDEMPOTENCY_KEY_TOO_LONG).toBe('幂等键最长 80 字');
  });

  it('没传或空白时不当成键', () => {
    expect(idempotencyKeyFromHeader(undefined)).toEqual({ key: null, error: null });
    expect(idempotencyKeyFromHeader(null)).toEqual({ key: null, error: null });
    expect(idempotencyKeyFromHeader('   ')).toEqual({ key: null, error: null });
    expect(idempotencyKeyFromHeader(['  order-1  '])).toEqual({ key: 'order-1', error: null });
  });
});
