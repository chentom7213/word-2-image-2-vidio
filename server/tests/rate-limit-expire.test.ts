import { describe, expect, it } from 'vitest';
import { needsRateLimitExpire } from '../src/lib/rate-limit-expire.js';

describe('needsRateLimitExpire', () => {
  it('计数为 1', () => {
    expect(needsRateLimitExpire(1, -1)).toBe(true);
  });

  it('计数大于 1 且 TTL 为 -1', () => {
    expect(needsRateLimitExpire(2, -1)).toBe(true);
  });

  it('计数大于 1 且 TTL 为 -2', () => {
    expect(needsRateLimitExpire(2, -2)).toBe(true);
  });

  it('计数大于 1 且 TTL 为 0', () => {
    expect(needsRateLimitExpire(2, 0)).toBe(false);
  });

  it('计数大于 1 且 TTL 为正数', () => {
    expect(needsRateLimitExpire(2, 30)).toBe(false);
  });
});
