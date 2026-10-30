import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  exec: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(),
  queryOne: mocks.queryOne,
  exec: mocks.exec,
  withTransaction: mocks.withTransaction,
}));

import { toMillis } from '../src/lib/dto.js';
import { rotateSession } from '../src/services/sessions.js';

/** Fixed MySQL DATETIME (no zone). The pool stores these as UTC. */
const FIXED_UTC = '2024-06-01 12:00:00';

function utcDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * A UTC wall-clock string that is still in the future via toMillis, but already
 * due if Date.parse reads it in the process-local zone. Impossible when the
 * process zone is UTC or west of UTC (local reading is not earlier).
 */
function localExpiredUtcActive(): string | null {
  const skew = toMillis(FIXED_UTC) - Date.parse(FIXED_UTC);
  if (!(skew > 0)) return null;
  const now = Date.now();
  const deltas = [Math.floor(skew / 2), 60_000, Math.max(1000, skew - 1000)];
  for (const delta of deltas) {
    if (delta <= 0) continue;
    const value = utcDateTime(now + delta);
    if (toMillis(value) > Date.now() && Date.parse(value) <= Date.now()) return value;
  }
  return null;
}

function expiryCheckUsesToMillis() {
  const source = readFileSync(new URL('../src/services/sessions.ts', import.meta.url), 'utf8');
  expect(source).toContain('toMillis(existing.expires_at) <= Date.now()');
  expect(source).not.toContain('Date.parse(existing.expires_at)');
}

describe('refresh token UTC expiry', () => {
  beforeEach(() => {
    mocks.queryOne.mockReset();
    mocks.exec.mockReset();
    mocks.exec.mockResolvedValue({ affectedRows: 1 });
    mocks.withTransaction.mockReset();
    mocks.withTransaction.mockImplementation(
      async (fn: (conn: { query: () => Promise<unknown[]> }) => Promise<unknown>) =>
        fn({
          query: async () => [{ affectedRows: 1 }],
        }),
    );
  });

  it('does not revoke a refresh token that is still valid in UTC', async () => {
    const value = localExpiredUtcActive();
    if (value) {
      expect(toMillis(value)).toBeGreaterThan(Date.now());
      expect(Date.parse(value)).toBeLessThanOrEqual(Date.now());

      mocks.queryOne.mockResolvedValue({
        id: 'session-1',
        user_id: 'user-1',
        family_id: 'family-1',
        token_hash: 'hash',
        expires_at: value,
        revoked_at: null,
        replaced_by: null,
      });

      await expect(rotateSession('raw-refresh-token')).resolves.toMatchObject({ userId: 'user-1' });
      const revokeSql = mocks.exec.mock.calls.map((call) => String(call[0]));
      expect(revokeSql.some((sql) => sql.includes('SET revoked_at = NOW()') && sql.includes('WHERE id = ?'))).toBe(
        false,
      );
      return;
    }

    const skew = toMillis(FIXED_UTC) - Date.parse(FIXED_UTC);
    expect(skew).toBeLessThanOrEqual(0);
    expect(toMillis(FIXED_UTC) - Date.parse(FIXED_UTC)).toBe(skew);
    expiryCheckUsesToMillis();
  });
});
