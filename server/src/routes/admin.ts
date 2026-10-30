import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne, exec } from '../db/pool.js';
import { parseAuditListQuery } from '../lib/audit-list-query.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireAuth, requireOrg, requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { orgMemberPredicate, orgTaskParams, orgTaskPredicate } from '../services/admin-scope.js';
import { listModels } from '../services/models.js';

/**
 * Back-office surface. Everything here is admin-only and fully audited —
 * model prices are money, so changing them must leave a trail.
 */
export async function adminRoutes(app: FastifyInstance) {
  const adminOnly = { preHandler: [requireAuth, requireOrg, requireRole('owner', 'admin')] };

  // ── Audit trail (append-only, filterable) ───────────────────────────────
  app.get('/api/admin/audit', adminOnly, async (req) => {
    const parsed = parseAuditListQuery(req.query as {
      limit?: unknown;
      action?: unknown;
      target?: unknown;
      userId?: unknown;
      before?: unknown;
    });
    if (parsed.error) throw badRequest(parsed.error);

    const where: string[] = [];
    const params: any[] = [];

    // Tenant isolation: an org admin sees their org's trail, plus legacy rows
    // written before `org_id` was populated (matched by membership instead).
    where.push(
      '(org_id = ? OR (org_id IS NULL AND user_id IN (SELECT user_id FROM memberships WHERE org_id = ?)))',
    );
    params.push(req.orgId!, req.orgId!);

    if (parsed.action) {
      where.push('action LIKE ?');
      params.push(`${parsed.action}%`);
    }
    if (parsed.target) {
      where.push('target = ?');
      params.push(parsed.target);
    }
    if (parsed.userId) {
      where.push('user_id = ?');
      params.push(parsed.userId);
    }
    if (parsed.beforeId) {
      where.push('id < ?');
      params.push(parsed.beforeId);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await query<any>(
      `SELECT id, user_id, action, target, ip, ua, meta, created_at
         FROM audit_logs ${clause}
        ORDER BY id DESC LIMIT ?`,
      [...params, parsed.limit],
    );
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        userId: r.user_id,
        action: r.action,
        target: r.target,
        ip: r.ip,
        ua: r.ua,
        meta: typeof r.meta === 'string' ? safeJson(r.meta) : r.meta,
        createdAt: r.created_at,
      })),
      nextCursor: rows.length === parsed.limit ? String(rows[rows.length - 1]?.id ?? '') : null,
    };
  });

  // ── Model registry ─────────────────────────────────────────────────────
  app.get('/api/admin/models', adminOnly, async () => {
    const rows = await query<any>('SELECT * FROM model_registry ORDER BY sort_weight ASC, id ASC');
    return {
      items: rows.map((m) => ({
        id: m.id,
        provider: m.provider,
        displayName: m.display_name,
        kind: m.kind,
        priceUnit: m.price_unit,
        priceAmount: Number(m.price_amount),
        maxDuration: m.max_duration === null ? null : Number(m.max_duration),
        resolutions: typeof m.resolutions === 'string' ? safeJson(m.resolutions) : m.resolutions,
        capabilities: typeof m.capabilities === 'string' ? safeJson(m.capabilities) : m.capabilities,
        providerModel: m.provider_model,
        enabled: Boolean(m.enabled),
        sortWeight: Number(m.sort_weight),
      })),
    };
  });

  const patchModelSchema = z.object({
    displayName: z.string().trim().min(1).max(120).optional(),
    priceAmount: z.number().int().min(0).max(1_000_000).optional(),
    priceUnit: z.enum(['per_second', 'per_call', 'per_image']).optional(),
    maxDuration: z.number().int().min(1).max(600).nullable().optional(),
    enabled: z.boolean().optional(),
    sortWeight: z.number().int().min(0).max(10_000).optional(),
    providerModel: z.string().max(120).optional(),
  });

  app.patch('/api/admin/models/:id', adminOnly, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = patchModelSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数错误');

    const existing = await queryOne<any>('SELECT * FROM model_registry WHERE id = ?', [id]);
    if (!existing) throw notFound('模型不存在');

    const sets: string[] = [];
    const params: any[] = [];
    const d = parsed.data;
    if (d.displayName !== undefined) {
      sets.push('display_name = ?');
      params.push(d.displayName);
    }
    if (d.priceAmount !== undefined) {
      sets.push('price_amount = ?');
      params.push(d.priceAmount);
    }
    if (d.priceUnit !== undefined) {
      sets.push('price_unit = ?');
      params.push(d.priceUnit);
    }
    if (d.maxDuration !== undefined) {
      sets.push('max_duration = ?');
      params.push(d.maxDuration);
    }
    if (d.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(d.enabled ? 1 : 0);
    }
    if (d.sortWeight !== undefined) {
      sets.push('sort_weight = ?');
      params.push(d.sortWeight);
    }
    if (d.providerModel !== undefined) {
      sets.push('provider_model = ?');
      params.push(d.providerModel);
    }
    if (sets.length === 0) throw badRequest('没有需要更新的字段');

    await exec(`UPDATE model_registry SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);

    await audit({
      userId: req.userId!,
      orgId: req.orgId,
      action: 'admin.model_update',
      target: id,
      ip: req.ip,
      meta: {
        before: {
          priceAmount: Number(existing.price_amount),
          priceUnit: existing.price_unit,
          enabled: Boolean(existing.enabled),
        },
        after: d,
      },
    });

    const updated = await queryOne<any>('SELECT * FROM model_registry WHERE id = ?', [id]);
    return {
      item: {
        id: updated!.id,
        displayName: updated!.display_name,
        priceUnit: updated!.price_unit,
        priceAmount: Number(updated!.price_amount),
        enabled: Boolean(updated!.enabled),
      },
    };
  });

  // ── Operations dashboard ───────────────────────────────────────────────
  app.get('/api/admin/stats', adminOnly, async (req) => {
    const orgId = req.orgId!;
    const taskWhere = orgTaskPredicate();
    const taskParams = orgTaskParams(orgId);
    const [taskStats] = await query<any>(
      `SELECT
         COUNT(*) AS total,
         SUM(status = 'queued')  AS queued,
         SUM(status = 'running') AS running,
         SUM(status = 'done')    AS done,
         SUM(status = 'failed')  AS failed,
         SUM(credits_cost)       AS credits_charged,
         SUM(CASE WHEN refunded_at IS NOT NULL THEN credits_cost ELSE 0 END) AS credits_refunded
       FROM generation_tasks
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         AND ${taskWhere}`,
      taskParams,
    );
    const [revenue] = await query<any>(
      `SELECT
         SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS granted,
         SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) AS spent,
         COUNT(DISTINCT user_id) AS active_users
       FROM credit_transactions
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         AND ${orgMemberPredicate('user_id')}`,
      [orgId],
    );
    const topErrors = await query<any>(
      `SELECT error_code, COUNT(*) AS c
         FROM generation_tasks
        WHERE status = 'failed' AND error_code IS NOT NULL
          AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
          AND ${taskWhere}
        GROUP BY error_code ORDER BY c DESC LIMIT 10`,
      taskParams,
    );
    const topModels = await query<any>(
      `SELECT model_id, COUNT(*) AS c, SUM(credits_cost) AS credits
         FROM generation_tasks
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
          AND ${taskWhere}
        GROUP BY model_id ORDER BY c DESC LIMIT 10`,
      taskParams,
    );

    const done = Number(taskStats?.done ?? 0);
    const failed = Number(taskStats?.failed ?? 0);
    const finished = done + failed;
    return {
      window: '30d',
      tasks: {
        total: Number(taskStats?.total ?? 0),
        queued: Number(taskStats?.queued ?? 0),
        running: Number(taskStats?.running ?? 0),
        done,
        failed,
        successRate: finished > 0 ? done / finished : null,
        creditsCharged: Number(taskStats?.credits_charged ?? 0),
        creditsRefunded: Number(taskStats?.credits_refunded ?? 0),
      },
      credits: {
        granted: Number(revenue?.granted ?? 0),
        spent: Number(revenue?.spent ?? 0),
        activeUsers: Number(revenue?.active_users ?? 0),
      },
      topErrors: topErrors.map((r) => ({ code: r.error_code, count: Number(r.c) })),
      topModels: topModels.map((r) => ({
        modelId: r.model_id,
        calls: Number(r.c),
        credits: Number(r.credits ?? 0),
      })),
    };
  });

  // ── Reconciliation (财务报表口径) ───────────────────────────────────────
  /**
   * Proves the two sources of truth agree: `users.credits` must equal the sum of
   * that user's ledger rows, and no task may carry two debit rows. Any drift is
   * a P0 incident, so this is exposed as a first-class endpoint instead of a
   * one-off SQL script somebody has to remember to run.
   *
   * Each list is a sample of at most 100 rows. `counts` is the full size of
   * that same filtered set, and `ok` is true only when every count is zero.
   */
  app.get('/api/admin/reconcile', adminOnly, async (req) => {
    const orgId = req.orgId!;
    const taskWhere = orgTaskPredicate();
    const taskParams = orgTaskParams(orgId);
    const driftBody = `FROM users u
         LEFT JOIN credit_transactions t ON t.user_id = u.id
        WHERE ${orgMemberPredicate('u.id')}
        GROUP BY u.id, u.email, u.credits
       HAVING u.credits <> COALESCE(SUM(t.delta), 0)`;
    const doubleBody = `FROM credit_transactions
        WHERE delta < 0 AND ref_id IS NOT NULL AND reason LIKE '生成任务扣费%'
          AND ref_id IN (SELECT id FROM generation_tasks WHERE ${taskWhere})
        GROUP BY ref_id HAVING COUNT(*) > 1`;
    const unrefundedBody = `FROM generation_tasks
        WHERE status = 'failed' AND credits_cost > 0 AND refunded_at IS NULL
          AND error_code <> 'CANCELLED'
          AND ${taskWhere}`;

    const [driftCount] = await query<any>(
      `SELECT COUNT(*) AS c FROM (SELECT u.id ${driftBody}) drift_count`,
      [orgId],
    );
    const drift = await query<any>(
      `SELECT u.id AS user_id, u.email, u.credits,
              COALESCE(SUM(t.delta), 0) AS ledger_total
         ${driftBody}
        LIMIT 100`,
      [orgId],
    );

    const [doubleCount] = await query<any>(
      `SELECT COUNT(*) AS c FROM (SELECT ref_id ${doubleBody}) double_count`,
      taskParams,
    );
    const doubleCharged = await query<any>(
      `SELECT ref_id, COUNT(*) AS c
         ${doubleBody}
        LIMIT 100`,
      taskParams,
    );

    const [unrefundedCount] = await query<any>(`SELECT COUNT(*) AS c ${unrefundedBody}`, taskParams);
    const unrefundedFailures = await query<any>(
      `SELECT id, credits_cost, error_code, created_at
         ${unrefundedBody}
        LIMIT 100`,
      taskParams,
    );

    const counts = {
      balanceDrift: Number(driftCount?.c ?? 0),
      doubleCharged: Number(doubleCount?.c ?? 0),
      unrefundedFailures: Number(unrefundedCount?.c ?? 0),
    };

    return {
      ok: counts.balanceDrift === 0 && counts.doubleCharged === 0 && counts.unrefundedFailures === 0,
      counts,
      balanceDrift: drift.map((r) => ({
        userId: r.user_id,
        email: r.email,
        credits: Number(r.credits),
        ledgerTotal: Number(r.ledger_total),
      })),
      doubleCharged: doubleCharged.map((r) => ({ taskId: r.ref_id, rows: Number(r.c) })),
      unrefundedFailures: unrefundedFailures.map((r) => ({
        taskId: r.id,
        cost: Number(r.credits_cost),
        code: r.error_code,
        createdAt: r.created_at,
      })),
    };
  });

  // ── Public-facing catalogue stays in /api/models; this is the admin view.
  app.get('/api/admin/models/public', adminOnly, async () => {
    const items = await listModels();
    return { items };
  });
}

function safeJson<T = any>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
