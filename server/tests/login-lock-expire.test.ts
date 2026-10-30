import { beforeEach, describe, expect, it, vi } from 'vitest';
import { needsLoginFailureExpire } from '../src/lib/login-lock-expire.js';

const LOCK_SEC = 15 * 60;

const mocks = vi.hoisted(() => ({
  available: true,
  incr: vi.fn(),
  expire: vi.fn(),
  ttl: vi.fn(),
  set: vi.fn(),
}));

vi.mock('../src/services/queue.js', () => ({
  redisAvailable: () => mocks.available,
  getRedis: () => mocks,
}));

import { noteLoginFailure } from '../src/services/login-lock.js';

describe('needsLoginFailureExpire', () => {
  it('次数是 1', () => {
    expect(needsLoginFailureExpire(1, -2)).toBe(true);
    expect(needsLoginFailureExpire(1, -1)).toBe(true);
    expect(needsLoginFailureExpire(1, 0)).toBe(true);
    expect(needsLoginFailureExpire(1, 60)).toBe(true);
  });

  it('次数大于 1 且 TTL 小于 0', () => {
    expect(needsLoginFailureExpire(2, -1)).toBe(true);
    expect(needsLoginFailureExpire(2, -2)).toBe(true);
    expect(needsLoginFailureExpire(10, -1)).toBe(true);
  });

  it('TTL 大于等于 0', () => {
    expect(needsLoginFailureExpire(2, 0)).toBe(false);
    expect(needsLoginFailureExpire(2, 1)).toBe(false);
    expect(needsLoginFailureExpire(10, LOCK_SEC)).toBe(false);
  });
});

describe('noteLoginFailure 补写 loginfail 过期时间', () => {
  beforeEach(() => {
    mocks.available = true;
    mocks.incr.mockReset();
    mocks.expire.mockReset();
    mocks.ttl.mockReset();
    mocks.set.mockReset();
    mocks.expire.mockResolvedValue(1);
    mocks.set.mockResolvedValue('OK');
  });

  it('次数是 1 就写 15 分钟，不读 TTL', async () => {
    mocks.incr.mockResolvedValue(1);
    await noteLoginFailure('203.0.113.1');
    expect(mocks.ttl).not.toHaveBeenCalled();
    expect(mocks.expire).toHaveBeenCalledTimes(1);
    expect(mocks.expire).toHaveBeenCalledWith('loginfail:203.0.113.1', LOCK_SEC);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('次数大于 1 且 TTL 为 -1 时补同一个 15 分钟', async () => {
    mocks.incr.mockResolvedValue(2);
    mocks.ttl.mockResolvedValue(-1);
    await noteLoginFailure('203.0.113.2');
    expect(mocks.ttl).toHaveBeenCalledWith('loginfail:203.0.113.2');
    expect(mocks.expire).toHaveBeenCalledTimes(1);
    expect(mocks.expire).toHaveBeenCalledWith('loginfail:203.0.113.2', LOCK_SEC);
  });

  it('次数大于 1 且 TTL 为 -2 时补同一个 15 分钟', async () => {
    mocks.incr.mockResolvedValue(3);
    mocks.ttl.mockResolvedValue(-2);
    await noteLoginFailure('203.0.113.3');
    expect(mocks.expire).toHaveBeenCalledWith('loginfail:203.0.113.3', LOCK_SEC);
  });

  it('次数大于 1 且 TTL 为 0 时不重新计时', async () => {
    mocks.incr.mockResolvedValue(4);
    mocks.ttl.mockResolvedValue(0);
    await noteLoginFailure('203.0.113.4');
    expect(mocks.ttl).toHaveBeenCalledWith('loginfail:203.0.113.4');
    expect(mocks.expire).not.toHaveBeenCalled();
  });

  it('次数大于 1 且 TTL 为正数时不重新计时', async () => {
    mocks.incr.mockResolvedValue(5);
    mocks.ttl.mockResolvedValue(42);
    await noteLoginFailure('203.0.113.5');
    expect(mocks.expire).not.toHaveBeenCalled();
  });

  it('达到 10 次仍 SET loginlock 并带 EX，已有过期时间不重写', async () => {
    mocks.incr.mockResolvedValue(10);
    mocks.ttl.mockResolvedValue(LOCK_SEC);
    await noteLoginFailure('203.0.113.10');
    expect(mocks.expire).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledWith('loginlock:203.0.113.10', '1', 'EX', LOCK_SEC);
  });

  it('写入失败仍吞掉', async () => {
    mocks.incr.mockRejectedValue(new Error('redis down'));
    await expect(noteLoginFailure('203.0.113.11')).resolves.toBeUndefined();
    expect(mocks.expire).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
