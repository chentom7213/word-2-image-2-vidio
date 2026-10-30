import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { toMillis } from '../lib/dto.js';
import { cursorStamp, generationCursorSql, parseGenerationPage } from '../services/generation-page.js';

/** Callers that omit `limit` keep the historical cap. */
const CREDIT_TX_DEFAULT_LIMIT = 100;

type TxRow = {
  id: string;
  delta: number;
  balance_after: number;
  reason: string;
  ref_id: string | null;
  created_at: string;
};

export async function creditRoutes(app: FastifyInstance) {
  app.get('/api/credits/transactions', { preHandler: [requireAuth] }, async (req) => {
    const { limit, before, beforeId } = req.query as {
      limit?: unknown;
      before?: unknown;
      beforeId?: unknown;
    };
    const page = parseGenerationPage({ limit, before, beforeId });
    if (page.error) throw badRequest(page.error);
    const pageSize = limit === undefined || limit === null || limit === '' ? CREDIT_TX_DEFAULT_LIMIT : page.limit;
    const cursor = generationCursorSql(page.cursor);
    const rows = await query<TxRow>(
      `SELECT * FROM credit_transactions WHERE user_id = ? ${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
      [req.userId!, ...cursor.params, pageSize],
    );
    const last = rows.length === pageSize ? rows[rows.length - 1] : null;
    const stamp = last ? cursorStamp(last.created_at) : null;
    return {
      items: rows.map((r) => ({
        id: r.id,
        delta: Number(r.delta),
        balanceAfter: Number(r.balance_after),
        reason: r.reason,
        refId: r.ref_id,
        createdAt: toMillis(r.created_at),
      })),
      nextCursor: last && stamp ? { createdAt: stamp, id: last.id } : null,
    };
  });

  app.get('/api/credits/balance', { preHandler: [requireAuth] }, async (req) => {
    const row = await queryOne<{ credits: number }>('SELECT credits FROM users WHERE id = ?', [
      req.userId!,
    ]);
    return { credits: Number(row?.credits ?? 0) };
  });

  /** Reconciliation view: lifetime grants/spend plus a refund total. */
  app.get('/api/credits/summary', { preHandler: [requireAuth] }, async (req) => {
    const row = await queryOne<{ gained: number | null; spent: number | null }>(
      `SELECT
         SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS gained,
         SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) AS spent
       FROM credit_transactions WHERE user_id = ?`,
      [req.userId!],
    );
    const balance = await queryOne<{ credits: number }>('SELECT credits FROM users WHERE id = ?', [req.userId!]);
    const refunds = await queryOne<{ total: number | null }>(
      `SELECT SUM(credits_cost) AS total FROM generation_tasks
        WHERE user_id = ? AND refunded_at IS NOT NULL`,
      [req.userId!],
    );
    return {
      balance: Number(balance?.credits ?? 0),
      gained: Number(row?.gained ?? 0),
      spent: Number(row?.spent ?? 0),
      refunded: Number(refunds?.total ?? 0),
    };
  });
}
