import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  available: true,
  incr: vi.fn(),
  expire: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
}));

vi.mock('../src/services/queue.js', () => ({
  redisAvailable: () => mocks.available,
  getRedis: () => mocks,
}));

import { checkRateLimit } from '../src/services/ratelimit.js';
import { loginLocked, noteLoginFailure } from '../src/services/login-lock.js';

describe('rate limit when Redis commands fail', () => {
  beforeEach(() => {
    mocks.available = true;
    mocks.incr.mockReset();
    mocks.expire.mockReset();
    mocks.incr.mockRejectedValue(new Error('redis down'));
  });

  it('keeps rejecting from the process counter', async () => {
    const key = `fallback-${Date.now()}`;
    await expect(checkRateLimit(key, 1, 60, '太频繁')).resolves.toBe(true);
    await expect(checkRateLimit(key, 1, 60, '太频繁')).rejects.toMatchObject({ statusCode: 429 });
  });
});

describe('login lock', () => {
  beforeEach(() => {
    mocks.available = true;
    mocks.incr.mockReset();
    mocks.expire.mockReset();
    mocks.get.mockReset();
    mocks.set.mockReset();
    mocks.del.mockReset();
    mocks.incr.mockResolvedValue(10);
    mocks.set.mockResolvedValue('OK');
    mocks.get.mockResolvedValue('1');
    mocks.del.mockResolvedValue(2);
  });

  it('writes a shared 15-minute lock after ten Redis failures', async () => {
    await noteLoginFailure('203.0.113.10');
    expect(mocks.set).toHaveBeenCalledWith('loginlock:203.0.113.10', '1', 'EX', 15 * 60);
    await expect(loginLocked('203.0.113.10')).resolves.toBe(true);
  });

  it('locks inside this process when Redis is down', async () => {
    mocks.available = false;
    const ip = '203.0.113.20';
    for (let i = 0; i < 9; i += 1) await noteLoginFailure(ip);
    await expect(loginLocked(ip)).resolves.toBe(false);
    await noteLoginFailure(ip);
    await expect(loginLocked(ip)).resolves.toBe(true);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('drops the process lock when Redis has no lock', async () => {
    mocks.available = false;
    const ip = '203.0.113.30';
    for (let i = 0; i < 10; i += 1) await noteLoginFailure(ip);
    await expect(loginLocked(ip)).resolves.toBe(true);
    mocks.available = true;
    mocks.get.mockResolvedValue(null);
    await expect(loginLocked(ip)).resolves.toBe(false);
    mocks.available = false;
    await expect(loginLocked(ip)).resolves.toBe(false);
  });

  it('keeps the process lock when the Redis read fails', async () => {
    mocks.available = false;
    const ip = '203.0.113.31';
    for (let i = 0; i < 10; i += 1) await noteLoginFailure(ip);
    mocks.available = true;
    mocks.get.mockRejectedValue(new Error('redis down'));
    await expect(loginLocked(ip)).resolves.toBe(true);
  });
});