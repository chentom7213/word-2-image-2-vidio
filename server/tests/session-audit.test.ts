import { beforeEach, describe, expect, it, vi } from 'vitest';

const queries: Array<{ sql: string; params: unknown[] }> = [];
let row: Record<string, unknown> | null = null;
let updateRows = 1;

vi.mock('../src/db/pool.js', () => ({
  query: async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return [];
  },
  queryOne: async () => row,
  exec: async () => ({ affectedRows: 1 }),
  withTransaction: async (fn: (conn: { query: () => Promise<unknown[]> }) => Promise<unknown>) =>
    fn({
      query: async () => [{ affectedRows: updateRows }],
    }),
}));

import { revokeSession, rotateSession } from '../src/services/sessions.js';

const reused = {
  id: 'session-1',
  user_id: 'user-1',
  family_id: 'family-1',
  token_hash: 'hash',
  expires_at: '2099-01-01T00:00:00.000Z',
  revoked_at: '2026-01-01 00:00:00',
  replaced_by: 'session-2',
};

describe('session reuse audit', () => {
  beforeEach(() => {
    queries.length = 0;
    row = reused;
    updateRows = 1;
  });

  it('records a replay without the refresh token', async () => {
    await expect(rotateSession('raw-refresh-token')).rejects.toMatchObject({ code: 'TOKEN_REUSE' });
    const audit = queries.find((item) => item.sql.includes('INSERT INTO audit_logs'));
    expect(audit?.params[1]).toBe('user-1');
    expect(audit?.params[2]).toBe('auth.token_reuse');
    expect(audit?.params[3]).toBe('family-1');
    expect(JSON.stringify(audit?.params)).toContain('replay');
    expect(JSON.stringify(audit?.params)).not.toContain('raw-refresh-token');
  });

  it('records a lost refresh race without revoking the winning family', async () => {
    row = { ...reused, revoked_at: null, replaced_by: null };
    updateRows = 0;
    await expect(rotateSession('raw-refresh-token')).rejects.toMatchObject({ code: 'TOKEN_REUSE' });
    const audit = queries.find((item) => item.sql.includes('INSERT INTO audit_logs'));
    expect(JSON.stringify(audit?.params)).toContain('race');
  });

  it('returns the user id when a logout revokes the family', async () => {
    await expect(revokeSession('raw-refresh-token')).resolves.toBe('user-1');
  });
});