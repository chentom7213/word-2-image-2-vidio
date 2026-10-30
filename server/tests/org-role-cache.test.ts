import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  exec: vi.fn(),
  withTransaction: vi.fn(),
  audit: vi.fn(),
  redisAvailable: vi.fn(),
  redisGet: vi.fn(),
  redisSetex: vi.fn(),
  redisDel: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  query: mocks.query,
  queryOne: mocks.queryOne,
  exec: mocks.exec,
  withTransaction: mocks.withTransaction,
}));
vi.mock('../src/services/audit.js', () => ({ audit: mocks.audit }));
vi.mock('../src/services/queue.js', () => ({
  redisAvailable: mocks.redisAvailable,
  getRedis: () => ({ get: mocks.redisGet, setex: mocks.redisSetex, del: mocks.redisDel }),
}));

import {
  getMembership,
  inviteMember,
  NO_MEMBERSHIP_SENTINEL,
  removeMember,
  roleCacheKey,
  ROLE_CACHE_TTL_SECONDS,
  updateMemberRole,
} from '../src/services/orgs.js';

describe('organization role cache', () => {
  beforeEach(() => {
    mocks.redisAvailable.mockReturnValue(true);
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSetex.mockResolvedValue('OK');
    mocks.redisDel.mockResolvedValue(1);
    mocks.exec.mockResolvedValue({ affectedRows: 1 });
    mocks.audit.mockResolvedValue(undefined);
  });

  it('returns a valid cached role without querying MySQL', async () => {
    mocks.redisGet.mockResolvedValue('admin');

    await expect(getMembership('cache-hit-user', 'org-1')).resolves.toBe('admin');
    expect(mocks.queryOne).not.toHaveBeenCalled();
  });

  it('loads a cache miss from MySQL and writes it with the configured TTL', async () => {
    mocks.queryOne.mockResolvedValue({ role: 'editor' });

    await expect(getMembership('cache-miss-user', 'org-1')).resolves.toBe('editor');
    expect(mocks.redisSetex).toHaveBeenCalledWith(
      roleCacheKey('cache-miss-user', 'org-1'),
      ROLE_CACHE_TTL_SECONDS,
      'editor',
    );
  });

  it('negative-caches a missing membership and serves the sentinel without MySQL', async () => {
    mocks.queryOne.mockResolvedValue(null);
    await expect(getMembership('missing-user', 'org-1')).resolves.toBeNull();
    expect(mocks.redisSetex).toHaveBeenCalledWith(
      roleCacheKey('missing-user', 'org-1'),
      ROLE_CACHE_TTL_SECONDS,
      NO_MEMBERSHIP_SENTINEL,
    );

    mocks.queryOne.mockClear();
    mocks.redisGet.mockResolvedValue(NO_MEMBERSHIP_SENTINEL);
    await expect(getMembership('sentinel-user', 'org-1')).resolves.toBeNull();
    expect(mocks.queryOne).not.toHaveBeenCalled();
  });

  it('falls back to MySQL when Redis is disabled or a read fails', async () => {
    mocks.redisAvailable.mockReturnValue(false);
    mocks.queryOne.mockResolvedValue({ role: 'viewer' });
    await expect(getMembership('redis-disabled-user', 'org-1')).resolves.toBe('viewer');
    expect(mocks.redisGet).not.toHaveBeenCalled();

    mocks.redisAvailable.mockReturnValue(true);
    mocks.redisGet.mockRejectedValue(new Error('redis down'));
    mocks.queryOne.mockResolvedValue({ role: 'owner' });
    await expect(getMembership('redis-error-user', 'org-1')).resolves.toBe('owner');
  });

  it('returns the authoritative DB role when cache write-through fails', async () => {
    mocks.queryOne.mockResolvedValue({ role: 'admin' });
    mocks.redisSetex.mockRejectedValue(new Error('redis write failed'));

    await expect(getMembership('write-error-user', 'org-1')).resolves.toBe('admin');
  });

  it('bypasses a stale Redis value after a failed write-through', async () => {
    mocks.queryOne.mockResolvedValueOnce({ role: 'admin' }).mockResolvedValueOnce({ role: 'owner' });
    mocks.redisSetex.mockRejectedValueOnce(new Error('redis write failed')).mockResolvedValueOnce('OK');

    await expect(getMembership('bypass-user', 'org-bypass')).resolves.toBe('admin');
    mocks.redisGet.mockResolvedValue('viewer');
    await expect(getMembership('bypass-user', 'org-bypass')).resolves.toBe('owner');

    expect(mocks.redisGet).toHaveBeenCalledTimes(1);
    expect(mocks.redisSetex).toHaveBeenLastCalledWith(
      roleCacheKey('bypass-user', 'org-bypass'),
      ROLE_CACHE_TTL_SECONDS,
      'owner',
    );
  });

  it('ignores malformed cached values', async () => {
    mocks.redisGet.mockResolvedValue('super-admin');
    mocks.queryOne.mockResolvedValue({ role: 'viewer' });

    await expect(getMembership('malformed-user', 'org-1')).resolves.toBe('viewer');
    expect(mocks.queryOne).toHaveBeenCalledTimes(1);
  });

  it('replaces a negative entry when a member is invited', async () => {
    mocks.queryOne.mockResolvedValueOnce({ id: 'invited-user' }).mockResolvedValueOnce(null);

    await expect(inviteMember('org-invite', 'member@example.com', 'editor', 'owner-user')).resolves.toBe(
      'invited-user',
    );
    expect(mocks.redisDel).toHaveBeenCalledWith(roleCacheKey('invited-user', 'org-invite'));
    expect(mocks.redisSetex).toHaveBeenCalledWith(
      roleCacheKey('invited-user', 'org-invite'),
      ROLE_CACHE_TTL_SECONDS,
      'editor',
    );
  });

  it('publishes a new role after the database update', async () => {
    mocks.queryOne.mockResolvedValue({ role: 'editor' });

    await updateMemberRole('org-update', 'member-user', 'viewer', 'owner-user');

    const updateOrder = mocks.exec.mock.invocationCallOrder[0];
    const cacheOrder = mocks.redisSetex.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(cacheOrder);
    expect(mocks.redisSetex).toHaveBeenCalledWith(
      roleCacheKey('member-user', 'org-update'),
      ROLE_CACHE_TTL_SECONDS,
      'viewer',
    );
  });

  it('does not let an older in-flight DB lookup overwrite a role mutation', async () => {
    let resolveOldLookup!: (value: { role: 'editor' }) => void;
    const oldLookup = new Promise<{ role: 'editor' }>((resolve) => {
      resolveOldLookup = resolve;
    });
    mocks.queryOne.mockReturnValueOnce(oldLookup).mockResolvedValueOnce({ role: 'editor' });

    const pendingLookup = getMembership('race-user', 'org-race');
    await vi.waitFor(() => expect(mocks.queryOne).toHaveBeenCalledTimes(1));
    await updateMemberRole('org-race', 'race-user', 'viewer', 'owner-user');
    resolveOldLookup({ role: 'editor' });

    await expect(pendingLookup).resolves.toBe('editor');
    expect(mocks.redisSetex).toHaveBeenCalledTimes(1);
    expect(mocks.redisSetex).toHaveBeenCalledWith(
      roleCacheKey('race-user', 'org-race'),
      ROLE_CACHE_TTL_SECONDS,
      'viewer',
    );
  });

  it('serializes an in-flight old cache write ahead of invalidation and the new role', async () => {
    let finishOldWrite!: (value: string) => void;
    const oldWrite = new Promise<string>((resolve) => {
      finishOldWrite = resolve;
    });
    mocks.queryOne.mockResolvedValueOnce({ role: 'editor' }).mockResolvedValueOnce({ role: 'editor' });
    mocks.redisSetex.mockReturnValueOnce(oldWrite).mockResolvedValueOnce('OK');

    const oldLookup = getMembership('write-race-user', 'org-write-race');
    await vi.waitFor(() => expect(mocks.redisSetex).toHaveBeenCalledTimes(1));
    const mutation = updateMemberRole('org-write-race', 'write-race-user', 'viewer', 'owner-user');

    await Promise.resolve();
    expect(mocks.exec).not.toHaveBeenCalled();
    finishOldWrite('OK');
    await expect(oldLookup).resolves.toBe('editor');
    await expect(mutation).resolves.toBeUndefined();

    expect(mocks.redisDel).toHaveBeenCalledWith(roleCacheKey('write-race-user', 'org-write-race'));
    expect(mocks.redisSetex).toHaveBeenLastCalledWith(
      roleCacheKey('write-race-user', 'org-write-race'),
      ROLE_CACHE_TTL_SECONDS,
      'viewer',
    );
    expect(mocks.redisSetex).toHaveBeenCalledTimes(2);
  });

  it('writes the negative sentinel after removing a member', async () => {
    mocks.queryOne.mockResolvedValue({ role: 'viewer' });

    await removeMember('org-remove', 'member-user', 'admin-user');

    expect(mocks.redisSetex).toHaveBeenCalledWith(
      roleCacheKey('member-user', 'org-remove'),
      ROLE_CACHE_TTL_SECONDS,
      NO_MEMBERSHIP_SENTINEL,
    );
  });

  it('does not turn a committed membership change into an API failure when Redis fails', async () => {
    mocks.queryOne.mockResolvedValue({ role: 'editor' });
    mocks.redisDel.mockRejectedValue(new Error('redis unavailable'));
    mocks.redisSetex.mockRejectedValue(new Error('redis unavailable'));

    await expect(updateMemberRole('org-resilient', 'member-user', 'viewer', 'owner-user')).resolves.toBeUndefined();
    expect(mocks.exec).toHaveBeenCalledWith('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?', [
      'viewer',
      'org-resilient',
      'member-user',
    ]);
  });
});
