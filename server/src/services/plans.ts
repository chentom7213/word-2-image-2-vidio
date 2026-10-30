import type { PoolConnection } from 'mysql2/promise';
import { query, queryOne, pool } from '../db/pool.js';
import { toMillis } from '../lib/dto.js';
import { ApiError } from '../lib/errors.js';

/**
 * Plan resolution and quota enforcement.
 *
 * Two invariants:
 *   1. A plan is always resolved from the DB, never from the client.
 *   2. An unknown / disabled plan falls back to `free`, never to "unlimited" —
 *      a misconfigured plan must degrade to the safest tier, not the most
 *      permissive one.
 */

export type Plan = {
  id: string;
  name: string;
  priceCents: number;
  monthlyCredits: number | null;
  maxConcurrent: number;
  maxDuration: number;
  rpm: number;
  features: Record<string, unknown>;
  sortWeight: number;
};

export type CreditPack = {
  id: string;
  name: string;
  credits: number;
  priceCents: number;
  bonus: number;
  sortWeight: number;
};

type PlanRow = {
  id: string;
  name: string;
  price_cents: number;
  monthly_credits: number | null;
  max_concurrent: number;
  max_duration: number;
  rpm: number;
  features: string | null;
  sort_weight: number;
};

function toPlan(r: PlanRow): Plan {
  let features: Record<string, unknown> = {};
  if (r.features) {
    try {
      features = typeof r.features === 'string' ? JSON.parse(r.features) : (r.features as any);
    } catch {
      features = {};
    }
  }
  return {
    id: r.id,
    name: r.name,
    priceCents: Number(r.price_cents),
    monthlyCredits: r.monthly_credits === null ? null : Number(r.monthly_credits),
    maxConcurrent: Number(r.max_concurrent),
    maxDuration: Number(r.max_duration),
    rpm: Number(r.rpm),
    features,
    sortWeight: Number(r.sort_weight),
  };
}

/** Hard-coded floor so a DB outage can never unlock unlimited concurrency. */
const FREE_PLAN: Plan = {
  id: 'free',
  name: '免费版',
  priceCents: 0,
  monthlyCredits: 1000,
  maxConcurrent: 1,
  maxDuration: 5,
  rpm: 20,
  features: { watermark: true },
  sortWeight: 0,
};

export async function listPlans(): Promise<Plan[]> {
  const rows = await query<PlanRow>(
    'SELECT * FROM plans WHERE enabled = 1 ORDER BY sort_weight ASC, id ASC',
  );
  return rows.map(toPlan);
}

export async function listCreditPacks(): Promise<CreditPack[]> {
  const rows = await query<any>(
    'SELECT * FROM credit_packs WHERE enabled = 1 ORDER BY sort_weight ASC, id ASC',
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    credits: Number(r.credits),
    priceCents: Number(r.price_cents),
    bonus: Number(r.bonus),
    sortWeight: Number(r.sort_weight),
  }));
}

export async function getPlan(planId: string): Promise<Plan | null> {
  const row = await queryOne<PlanRow>('SELECT * FROM plans WHERE id = ? AND enabled = 1', [planId]);
  return row ? toPlan(row) : null;
}

/**
 * The caller's effective plan. An expired paid plan silently degrades to free —
 * the user keeps access to what they already paid for, but not new privileges.
 */
export async function planForUser(userId: string): Promise<Plan> {
  const row = await queryOne<{ plan_id: string | null; plan_expires_at: string | null }>(
    'SELECT plan_id, plan_expires_at FROM users WHERE id = ?',
    [userId],
  );
  if (!row?.plan_id) return FREE_PLAN;

  if (row.plan_expires_at && toMillis(row.plan_expires_at) <= Date.now()) {
    return FREE_PLAN;
  }

  return (await getPlan(row.plan_id)) ?? FREE_PLAN;
}

/**
 * Count of this user's queued and running tasks.
 * `excludeTaskId` drops that row so a retry is not charged a slot against itself.
 */
export function activeTaskCountQuery(
  userId: string,
  excludeTaskId?: string,
): { sql: string; params: string[] } {
  const sql =
    "SELECT COUNT(*) AS c FROM generation_tasks WHERE user_id = ? AND status IN ('queued','running')";
  if (excludeTaskId == null) return { sql, params: [userId] };
  return { sql: `${sql} AND id <> ?`, params: [userId, excludeTaskId] };
}

/**
 * Concurrent-task gate.
 *
 * Counts `queued` + `running` for the user and rejects when the plan ceiling is
 * reached. This is the knob that stops one account from occupying every worker
 * slot — a plain rate limit does not, because requests are cheap and async.
 *
 * `precheckConcurrency` is only a fast path for good UX. The authoritative
 * check is `reserveConcurrencySlot`, called inside the creation transaction:
 * count-then-insert is a TOCTOU race under real parallelism, so it must be
 * serialized per user.
 */
export async function precheckConcurrency(
  userId: string,
  maxConcurrent: number,
  excludeTaskId?: string,
): Promise<number> {
  const count = activeTaskCountQuery(userId, excludeTaskId);
  const row = await queryOne<{ c: number }>(count.sql, count.params);
  const active = Number(row?.c ?? 0);
  if (active >= maxConcurrent) {
    throw new ApiError(
      429,
      `当前套餐最多同时进行 ${maxConcurrent} 个任务，请等待已有任务完成或升级套餐`,
      'CONCURRENCY_LIMIT',
    );
  }
  return active;
}

/** @deprecated Use `precheckConcurrency` (fast path) + `reserveConcurrencySlot`. */
export const assertConcurrencyAllowed = precheckConcurrency;

/**
 * Runs `fn` inside a transaction while holding a per-user quota lock.
 *
 * Why one connection for both:
 *
 *  - Count-then-insert is a TOCTOU race; every parallel request would see the
 *    same free slot before any insert landed.
 *  - MySQL's default REPEATABLE READ means a *different* connection cannot see
 *    the uncommitted insert, so releasing the lock before commit re-opens the
 *    race.
 *  - Holding the lock on a SECOND connection while the transaction uses another
 *    doubles connection demand per request and exhausts the pool under bursts
 *    (observed as spurious 429s at 10 parallel requests).
 *
 * So: one pooled connection → GET_LOCK → BEGIN → count → fn() → COMMIT →
 * RELEASE_LOCK. The lock is released only after the insert is visible to
 * others, and only one connection is consumed.
 */
export async function withQuotaTransaction<T>(
  userId: string,
  maxConcurrent: number,
  fn: (conn: PoolConnection) => Promise<T>,
  excludeTaskId?: string,
): Promise<T> {
  const conn = await pool.getConnection();
  const lockName = `quota:${userId}`;
  let locked = false;

  try {
    const [rows] = await conn.query<any[]>('SELECT GET_LOCK(?, 5) AS ok', [lockName]);
    if (Number(rows?.[0]?.ok ?? 0) !== 1) {
      throw new ApiError(429, '系统繁忙，请稍后重试', 'CONCURRENCY_LIMIT');
    }
    locked = true;

    await conn.beginTransaction();
    try {
      // Snapshot taken after the lock, so it reflects the previous holder's
      // committed insert.
      const count = activeTaskCountQuery(userId, excludeTaskId);
      const [countRows] = await conn.query<any[]>(count.sql, count.params);
      const active = Number(countRows?.[0]?.c ?? 0);
      if (active >= maxConcurrent) {
        throw new ApiError(
          429,
          `当前套餐最多同时进行 ${maxConcurrent} 个任务，请等待已有任务完成或升级套餐`,
          'CONCURRENCY_LIMIT',
        );
      }

      const out = await fn(conn);
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    }
  } finally {
    if (locked) await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
    conn.release();
  }
}

export async function activeTaskCount(userId: string): Promise<number> {
  const row = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM generation_tasks WHERE user_id = ? AND status IN ('queued','running')`,
    [userId],
  );
  return Number(row?.c ?? 0);
}
