import { beforeEach, describe, expect, it, vi } from 'vitest';

const queries: Array<{ sql: string; params: unknown[] }> = [];
const execs: string[] = [];
let rows: Array<Record<string, unknown>> = [];

vi.mock('../src/db/pool.js', () => ({
  query: async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return rows;
  },
  queryOne: async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return rows[0] ?? null;
  },
  exec: async (sql: string) => {
    execs.push(sql);
    return { affectedRows: 1 };
  },
  withTransaction: async (fn: (conn: unknown) => Promise<unknown>) => fn({}),
}));

import { hashToken, listActiveSessions, revokeOwnedSession } from '../src/services/sessions.js';

describe('active session list', () => {
  beforeEach(() => {
    queries.length = 0;
    execs.length = 0;
    rows = [];
  });

  it('marks the presented cookie and omits the token hash', async () => {
    const current = 'raw-refresh-token';
    rows = [
      {
        id: 'session-1',
        token_hash: hashToken(current),
        ip: '203.0.113.9',
        user_agent: 'Browser',
        created_at: '2026-10-26 10:00:00',
      },
    ];
    const items = await listActiveSessions('user-1', current);
    expect(items).toEqual([
      {
        id: 'session-1',
        createdAt: '2026-10-26 10:00:00',
        ip: '203.0.113.9',
        userAgent: 'Browser',
        current: true,
      },
    ]);
    expect(JSON.stringify(items)).not.toContain(hashToken(current));
    expect(JSON.stringify(items)).not.toContain(current);
  });

  it('revokes only a live session owned by the caller', async () => {
    rows = [{ family_id: 'family-1', token_hash: 'stored-hash' }];
    await expect(revokeOwnedSession('user-1', 'session-1')).resolves.toEqual({ tokenHash: 'stored-hash' });
    expect(queries[0]?.params).toEqual(['session-1', 'user-1']);
    expect(execs.some((sql) => sql.includes('family_id'))).toBe(true);

    rows = [];
    await expect(revokeOwnedSession('user-1', 'missing')).resolves.toBeNull();
  });
});
