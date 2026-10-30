import { randomUUID } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../db/pool.js';
import { parseUtcMillis } from '../lib/dto.js';
import { emitProcessLog, oneLineDetail } from '../lib/process-log.js';
import { adjustCredits } from './credits.js';

const MONTH_DAYS = 30;

type EntitlementRow = {
  id: string;
  plan_id: string;
  plan_expires_at: string;
  monthly_credits: number | null;
};

type GrantRow = { period_start: string };

export type MonthlyGrantRun = { granted: number; skipped: number; failed: number };

/** A calendar-safe comparison used both by the runner and its unit tests. */
export function isMonthlyGrantDue(lastPeriodStart: Date | null, now: Date): boolean {
  if (!lastPeriodStart) return true;
  const next = new Date(lastPeriodStart);
  next.setUTCDate(next.getUTCDate() + MONTH_DAYS);
  return next <= now;
}

export function asUtcDate(value: string): Date {
  const ms = parseUtcMillis(value);
  return new Date(ms ?? Number.NaN);
}

/** Records the payment-time grant in the same transaction as the order credit. */
export async function recordInitialPlanGrant(
  conn: PoolConnection,
  input: { userId: string; planId: string; credits: number; orderId: string },
): Promise<void> {
  if (input.credits <= 0) return;
  await conn.query(
    `INSERT INTO monthly_credit_grants
       (id, user_id, plan_id, period_start, credits, source_order_id)
     VALUES (?, ?, ?, NOW(), ?, ?)`,
    [randomUUID(), input.userId, input.planId, input.credits, input.orderId],
  );
}

async function grantOne(userId: string, now: Date): Promise<'granted' | 'skipped'> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<any[]>(
      `SELECT u.id, u.plan_id, u.plan_expires_at, p.monthly_credits
         FROM users u JOIN plans p ON p.id = u.plan_id AND p.enabled = 1
        WHERE u.id = ? AND u.plan_id <> 'free' AND u.plan_expires_at > UTC_TIMESTAMP()
        FOR UPDATE`,
      [userId],
    );
    const entitlement = rows[0] as EntitlementRow | undefined;
    const credits = Number(entitlement?.monthly_credits ?? 0);
    if (!entitlement || credits <= 0) {
      await conn.commit();
      return 'skipped';
    }

    const [lastRows] = await conn.query<any[]>(
      `SELECT period_start FROM monthly_credit_grants
        WHERE user_id = ? AND plan_id = ?
        ORDER BY period_start DESC LIMIT 1 FOR UPDATE`,
      [userId, entitlement.plan_id],
    );
    const lastGrant = lastRows[0] as GrantRow | undefined;
    const last = lastGrant ? asUtcDate(lastGrant.period_start) : null;
    if (!isMonthlyGrantDue(last, now)) {
      await conn.commit();
      return 'skipped';
    }

    const periodStart = last
      ? new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate() + MONTH_DAYS))
      : now;
    const grantId = randomUUID();
    await conn.query(
      `INSERT INTO monthly_credit_grants (id, user_id, plan_id, period_start, credits)
       VALUES (?, ?, ?, ?, ?)`,
      [grantId, userId, entitlement.plan_id, periodStart, credits],
    );
    await adjustCredits(conn, userId, credits, `套餐月度积分 · ${entitlement.plan_id}`, grantId);
    await conn.commit();
    return 'granted';
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Grants every active paid subscription that is due.  It is intentionally safe
 * to invoke from a cron job, an API process, and several worker replicas at
 * once: each user is row-locked and the grant ledger is append-only.
 */
export async function grantDueMonthlyCredits(now = new Date()): Promise<MonthlyGrantRun> {
  const [users] = await pool.query<any[]>(
    `SELECT id FROM users
      WHERE plan_id <> 'free' AND plan_expires_at > UTC_TIMESTAMP()
      ORDER BY id ASC`,
  );
  const out: MonthlyGrantRun = { granted: 0, skipped: 0, failed: 0 };
  for (const user of users as { id: string }[]) {
    try {
      const result = await grantOne(user.id, now);
      out[result] += 1;
    } catch (err) {
      out.failed += 1;
      emitProcessLog('error', `[monthly-credits] user=${user.id} grant failed: ${oneLineDetail(err)}`, {
        msg: 'monthly credit grant failed',
        userId: user.id,
        error: oneLineDetail(err),
      });
    }
  }
  return out;
}

/**
 * Starts an in-process safety-net scheduler.  Running it in several replicas
 * is intentional: the database ledger and row locks make concurrent scans
 * harmless, while every deployment style (embedded or dedicated worker) gets
 * automatic grants without relying on a specific host's crontab.
 */
export function startMonthlyCreditScheduler(intervalMs: number): NodeJS.Timeout {
  const run = () => {
    void grantDueMonthlyCredits()
      .then((result) => {
        if (result.granted || result.failed) {
          emitProcessLog(
            'info',
            `[monthly-credits] granted=${result.granted} skipped=${result.skipped} failed=${result.failed}`,
            {
              msg: 'monthly credits',
              granted: result.granted,
              skipped: result.skipped,
              failed: result.failed,
            },
          );
        }
      })
      .catch((err) =>
        emitProcessLog('error', `[monthly-credits] scan failed: ${oneLineDetail(err)}`, {
          msg: 'monthly credit scan failed',
          error: oneLineDetail(err),
        }),
      );
  };
  run();
  return setInterval(run, Math.max(60_000, intervalMs));
}
