import { readFileSync } from 'node:fs';
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
  pool: {},
}));
vi.mock('../src/services/ratelimit.js', () => ({ checkRateLimit: mocks.checkRateLimit }));

import { toMillis } from '../src/lib/dto.js';
import { hashKey, verifyApiKey } from '../src/services/apiKeys.js';
import { planForUser } from '../src/services/plans.js';

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

function sqlExpiryUsesUtcTimestamp() {
  const sessions = readFileSync(new URL('../src/services/sessions.ts', import.meta.url), 'utf8');
  const billing = readFileSync(new URL('../src/routes/billing.ts', import.meta.url), 'utf8');
  const payments = readFileSync(new URL('../src/services/payments.ts', import.meta.url), 'utf8');
  const monthly = readFileSync(new URL('../src/services/monthlyCredits.ts', import.meta.url), 'utf8');
  expect(sessions).toContain('expires_at > UTC_TIMESTAMP()');
  expect(sessions).not.toContain('expires_at > NOW()');
  expect(sessions).not.toContain('expires_at < NOW()');
  expect(billing).toContain('expires_at < UTC_TIMESTAMP()');
  expect(billing).not.toContain('expires_at < NOW()');
  expect(payments).toContain('UTC_TIMESTAMP()');
  expect(payments).not.toContain('plan_expires_at, NOW()');
  expect(monthly).not.toContain('plan_expires_at > NOW()');
}

function expiryChecksUseToMillis() {
  const plans = readFileSync(new URL('../src/services/plans.ts', import.meta.url), 'utf8');
  const keys = readFileSync(new URL('../src/services/apiKeys.ts', import.meta.url), 'utf8');
  expect(plans).toContain('toMillis(row.plan_expires_at) <= Date.now()');
  expect(keys).toContain('toMillis(row.expires_at) < Date.now()');
  expect(plans).not.toContain('Date.parse(row.plan_expires_at)');
  expect(keys).not.toContain('Date.parse(row.expires_at)');
}

describe('UTC DATETIME expiry', () => {
  beforeEach(() => {
    mocks.queryOne.mockReset();
    mocks.exec.mockReset();
    mocks.exec.mockResolvedValue({ affectedRows: 1 });
    mocks.checkRateLimit.mockReset();
    mocks.checkRateLimit.mockResolvedValue(true);
  });

  it('keeps a plan and an API key that are still valid in UTC', async () => {
    const value = localExpiredUtcActive();
    if (value) {
      expect(toMillis(value)).toBeGreaterThan(Date.now());
      expect(Date.parse(value)).toBeLessThanOrEqual(Date.now());

      mocks.queryOne.mockImplementation(async (sql: string) => {
        if (sql.includes('plan_expires_at')) return { plan_id: 'pro', plan_expires_at: value };
        if (sql.includes('FROM plans')) {
          return {
            id: 'pro',
            name: '专业版',
            price_cents: 9900,
            monthly_credits: 10000,
            max_concurrent: 4,
            max_duration: 10,
            rpm: 60,
            features: null,
            sort_weight: 2,
          };
        }
        return null;
      });
      await expect(planForUser('user-1')).resolves.toMatchObject({ id: 'pro' });

      const plain = 'bk_live_utc_expiry';
      mocks.queryOne.mockResolvedValue({
        id: 'key-1',
        org_id: 'org-1',
        owner_id: 'user-1',
        key_hash: hashKey(plain),
        scopes: ['generate:image'],
        rate_limit: 60,
        revoked_at: null,
        expires_at: value,
      });
      await expect(verifyApiKey(plain)).resolves.toMatchObject({ keyId: 'key-1' });
      return;
    }

    const skew = toMillis(FIXED_UTC) - Date.parse(FIXED_UTC);
    expect(skew).toBeLessThanOrEqual(0);
    expect(toMillis(FIXED_UTC) - Date.parse(FIXED_UTC)).toBe(skew);
    expiryChecksUseToMillis();
  });

  it('compares stored expiry with UTC_TIMESTAMP instead of session NOW()', () => {
    sqlExpiryUsesUtcTimestamp();
  });
});
