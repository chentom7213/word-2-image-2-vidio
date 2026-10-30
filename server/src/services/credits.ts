import type { PoolConnection } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../lib/errors.js';

/**
 * Adjust a user's balance and record a transaction row.
 * MUST be called inside a transaction — locks the user row with FOR UPDATE.
 * Returns the new balance. Throws 402 if it would go negative.
 */
export async function adjustCredits(
  conn: PoolConnection,
  userId: string,
  delta: number,
  reason: string,
  refId: string | null = null,
): Promise<number> {
  const [rows] = await conn.query<any[]>(
    'SELECT credits FROM users WHERE id = ? FOR UPDATE',
    [userId],
  );
  if (rows.length === 0) throw new ApiError(404, '用户不存在', 'NO_USER');

  const current = Number(rows[0].credits);
  const next = current + delta;
  if (next < 0) throw new ApiError(402, '积分不足', 'INSUFFICIENT_CREDITS');

  await conn.query('UPDATE users SET credits = ? WHERE id = ?', [next, userId]);
  await conn.query(
    'INSERT INTO credit_transactions (id, user_id, delta, balance_after, reason, ref_id) VALUES (?, ?, ?, ?, ?, ?)',
    [randomUUID(), userId, delta, next, reason, refId],
  );
  return next;
}
