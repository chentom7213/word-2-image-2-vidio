import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/pool.js', () => ({
  exec: vi.fn(),
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
  pool: {},
}));

vi.mock('../src/services/storage.js', () => ({
  keys: { output: () => 'outputs/unused' },
  putObjectFromPath: vi.fn(),
  removeObject: vi.fn(),
  signedUrl: (key: string) => `/media/${key}`,
  storageRoot: 'unused',
}));

import { storedQueuePriority } from '../src/services/pipeline.js';

describe('storedQueuePriority', () => {
  it('有限数字原样使用，已经写成 5 的保持 5', () => {
    expect(storedQueuePriority(1)).toBe(1);
    expect(storedQueuePriority(3)).toBe(3);
    expect(storedQueuePriority(5)).toBe(5);
    expect(storedQueuePriority(7)).toBe(7);
    expect(storedQueuePriority(0)).toBe(0);
    expect(storedQueuePriority(-1)).toBe(-1);
    expect(storedQueuePriority(1.5)).toBe(1.5);
    expect(Object.is(storedQueuePriority(-0), -0)).toBe(true);
  });

  it('数字字符串里的有限数字原样使用', () => {
    expect(storedQueuePriority('1')).toBe(1);
    expect(storedQueuePriority('5')).toBe(5);
    expect(storedQueuePriority(' 7 ')).toBe(7);
    expect(storedQueuePriority('1.5')).toBe(1.5);
  });

  it('读不到有限数字时用 5', () => {
    expect(storedQueuePriority(undefined)).toBe(5);
    expect(storedQueuePriority(null)).toBe(5);
    expect(storedQueuePriority(Number.NaN)).toBe(5);
    expect(storedQueuePriority(Number.POSITIVE_INFINITY)).toBe(5);
    expect(storedQueuePriority(Number.NEGATIVE_INFINITY)).toBe(5);
    expect(storedQueuePriority('')).toBe(5);
    expect(storedQueuePriority('   ')).toBe(5);
    expect(storedQueuePriority('abc')).toBe(5);
    expect(storedQueuePriority(true)).toBe(5);
    expect(storedQueuePriority(false)).toBe(5);
    expect(storedQueuePriority({})).toBe(5);
    expect(storedQueuePriority([])).toBe(5);
  });
});
