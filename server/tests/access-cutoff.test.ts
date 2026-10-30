import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signToken, verifyToken } from '../src/lib/jwt.js';
import { accessIssuedBeforeCutoff } from '../src/services/access-cutoff.js';

const here = dirname(fileURLToPath(import.meta.url));
const execs: string[] = [];
let execError: Error | null = null;

vi.mock('../src/db/pool.js', () => ({
  query: async () => [],
  queryOne: async () => null,
  exec: async (sql: string) => {
    execs.push(sql);
    if (execError && sql.includes('tokens_valid_after')) throw execError;
    return { affectedRows: 1 };
  },
  withTransaction: async (fn: (conn: unknown) => Promise<unknown>) => fn({}),
}));

import { revokeAllForUser } from '../src/services/sessions.js';

describe('access token cutoff', () => {
  beforeEach(() => {
    execs.length = 0;
    execError = null;
  });

  it('rejects tokens issued at or before the cutoff and keeps later ones', () => {
    expect(accessIssuedBeforeCutoff(1_700_000_000, null)).toBe(false);
    expect(accessIssuedBeforeCutoff(1_700_000_000, '')).toBe(false);
    expect(accessIssuedBeforeCutoff(1_700_000_000, 'not-a-date')).toBe(false);
    expect(accessIssuedBeforeCutoff(undefined, '2026-10-26 10:00:00.000')).toBe(true);
    expect(accessIssuedBeforeCutoff(Date.parse('2026-10-26T09:00:00.000Z') / 1000, '2026-10-26 10:00:00.000')).toBe(true);
    expect(accessIssuedBeforeCutoff(Date.parse('2026-10-26T10:00:00.000Z') / 1000, '2026-10-26 10:00:00.000')).toBe(true);
    expect(accessIssuedBeforeCutoff(Date.parse('2026-10-26T10:00:01.000Z') / 1000, '2026-10-26 10:00:00.000')).toBe(false);
  });

  it('puts the issued-at second on verified access tokens', () => {
    const payload = verifyToken(signToken({ sub: 'user-1', email: 'a@example.com' }));
    expect(payload.iat).toBeGreaterThan(1_700_000_000);
    expect(accessIssuedBeforeCutoff(payload.iat, '2099-01-01 00:00:00.000')).toBe(true);
  });

  it('stamps the cutoff when every session is revoked', async () => {
    await revokeAllForUser('user-1');
    expect(execs.some((sql) => sql.includes('tokens_valid_after = UTC_TIMESTAMP(3)'))).toBe(true);
  });

  it('leaves logout working when the cutoff column is not migrated yet', async () => {
    execError = Object.assign(new Error("Unknown column 'tokens_valid_after'"), { code: 'ER_BAD_FIELD_ERROR' });
    await expect(revokeAllForUser('user-1')).resolves.toBeUndefined();
  });

  it('adds a nullable cutoff without touching foreign keys', () => {
    const migration = readFileSync(join(here, '../src/db/migrations/0013_user_tokens_valid_after.sql'), 'utf8').replace(/--.*$/gm, '');
    const schema = readFileSync(join(here, '../src/db/schema.sql'), 'utf8');
    expect(migration).toContain('tokens_valid_after DATETIME(3) NULL');
    expect(migration).toMatch(/information_schema\.COLUMNS/);
    expect(migration).not.toMatch(/FOREIGN KEY/i);
    expect(migration).not.toMatch(/PARTITION/i);
    expect(schema).toContain('tokens_valid_after  DATETIME(3)  NULL');
  });
});
