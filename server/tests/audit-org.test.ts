import { beforeEach, describe, expect, it, vi } from 'vitest';

const queries: Array<{ sql: string; params: unknown[] }> = [];

vi.mock('../src/services/queue.js', () => ({
  redisAvailable: () => false,
  getRedis: () => {
    throw new Error('redis unused');
  },
}));

vi.mock('../src/db/pool.js', () => ({
  query: async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return [];
  },
  queryOne: async (sql: string) => {
    if (sql.includes('FROM users')) return { id: 'user-9' };
    return null;
  },
  exec: async () => ({ affectedRows: 1 }),
  withTransaction: async (fn: (conn: { query: () => Promise<unknown> }) => Promise<unknown>) => fn({ query: async () => [[]] }),
}));

import { inviteMember } from '../src/services/orgs.js';

describe('org audit scope', () => {
  beforeEach(() => {
    queries.length = 0;
  });

  it('writes the organization onto an invite audit row', async () => {
    await inviteMember('org-9', 'member@example.com', 'editor', 'actor-1');
    const audit = queries.find((item) => item.sql.includes('INSERT INTO audit_logs'));
    expect(audit?.params[0]).toBe('org-9');
    expect(audit?.params[2]).toBe('org.invite');
  });
});