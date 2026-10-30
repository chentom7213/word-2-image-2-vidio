import { beforeEach, describe, expect, it, vi } from 'vitest';

const queries: Array<{ sql: string; params: unknown[] }> = [];
const execResult = { affectedRows: 1 };

vi.mock('../src/db/pool.js', () => ({
  query: async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return [];
  },
  queryOne: async () => null,
  exec: async () => execResult,
}));
vi.mock('../src/services/ratelimit.js', () => ({ checkRateLimit: vi.fn() }));

import { createApiKey, revokeApiKey } from '../src/services/apiKeys.js';

describe('API key audit', () => {
  beforeEach(() => {
    queries.length = 0;
    execResult.affectedRows = 1;
  });

  it('records creation without the full secret', async () => {
    const created = await createApiKey('org-1', 'user-1', 'ci', ['generate:image'], 30, null);
    const audit = queries.find((item) => item.sql.includes('INSERT INTO audit_logs'));
    expect(audit?.params[0]).toBe('org-1');
    expect(audit?.params[1]).toBe('user-1');
    expect(audit?.params[2]).toBe('apikey.create');
    expect(JSON.stringify(audit?.params)).not.toContain(created.plain);
    expect(JSON.stringify(audit?.params)).toContain(created.prefix);
  });

  it('records a revocation and skips a missing key', async () => {
    await revokeApiKey('org-1', 'key-1', 'user-1');
    const audit = queries.find((item) => item.sql.includes('INSERT INTO audit_logs'));
    expect(audit?.params[2]).toBe('apikey.revoke');
    expect(audit?.params[3]).toBe('key-1');

    queries.length = 0;
    execResult.affectedRows = 0;
    await expect(revokeApiKey('org-1', 'missing', 'user-1')).rejects.toMatchObject({ statusCode: 404 });
    expect(queries.some((item) => item.sql.includes('INSERT INTO audit_logs'))).toBe(false);
  });
});