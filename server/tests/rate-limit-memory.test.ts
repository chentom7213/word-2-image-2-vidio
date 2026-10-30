import { describe, expect, it } from 'vitest';
import { memoryRateAllows, type MemoryBucket } from '../src/lib/rate-limit-memory.js';

describe('in-process rate window', () => {
  it('keeps the first-hit window across a clock minute', () => {
    const buckets = new Map<string, MemoryBucket>();
    expect(memoryRateAllows(buckets, 'user', 2, 60, 50_000)).toBe(true);
    expect(memoryRateAllows(buckets, 'user', 2, 60, 50_000)).toBe(true);
    expect(memoryRateAllows(buckets, 'user', 2, 60, 60_000)).toBe(false);
    expect(memoryRateAllows(buckets, 'user', 2, 60, 109_999)).toBe(false);
    expect(memoryRateAllows(buckets, 'user', 2, 60, 110_000)).toBe(true);
  });
});
