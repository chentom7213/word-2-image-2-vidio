import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  exec: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(),
  queryOne: mocks.queryOne,
  exec: mocks.exec,
}));
vi.mock('../src/services/ratelimit.js', () => ({ checkRateLimit: mocks.checkRateLimit }));

import { ApiError } from '../src/lib/errors.js';
import { hashKey, verifyApiKey } from '../src/services/apiKeys.js';

const plain = 'bk_live_rate_test';

describe('API key rate limit', () => {
  beforeEach(() => {
    mocks.checkRateLimit.mockReset();
    mocks.checkRateLimit.mockResolvedValue(true);
    mocks.exec.mockReset();
    mocks.exec.mockResolvedValue({ affectedRows: 1 });
    mocks.queryOne.mockReset();
    mocks.queryOne.mockResolvedValue({
      id: 'key-1',
      org_id: 'org-1',
      owner_id: 'user-1',
      key_hash: hashKey(plain),
      scopes: ['generate:image'],
      rate_limit: 15,
      revoked_at: null,
      expires_at: null,
    });
  });

  it('uses the shared limiter and the key’s own rpm', async () => {
    const ctx = await verifyApiKey(plain);
    expect(ctx.keyId).toBe('key-1');
    expect(mocks.checkRateLimit).toHaveBeenCalledWith('apikey:key-1', 15, 60, 'API Key 请求过于频繁');
    expect(mocks.exec).toHaveBeenCalled();
  });

  it('does not mark the key used when the limiter rejects', async () => {
    mocks.checkRateLimit.mockRejectedValue(new ApiError(429, 'API Key 请求过于频繁', 'TOO_MANY'));
    await expect(verifyApiKey(plain)).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY' });
    expect(mocks.exec).not.toHaveBeenCalled();
  });
});