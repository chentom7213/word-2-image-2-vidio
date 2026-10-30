import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { query, queryOne, exec } from '../db/pool.js';
import { parseAdminOrderQuery } from '../lib/admin-order-query.js';
import { checkoutBodyMessage } from '../lib/checkout-body.js';
import { checkoutFieldProblem, shouldReleaseCheckoutIdempotency } from '../lib/checkout-field.js';
import { toMillis } from '../lib/dto.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { idempotencyKeyFromHeader } from '../lib/idempotency-key.js';
import { requireAuth, requireOrg, requireRole } from '../middleware/auth.js';
import { checkRateLimit } from '../services/ratelimit.js';
import { audit } from '../services/audit.js';
import { cursorStamp, generationCursorSql, parseGenerationPage } from '../services/generation-page.js';
import { activeTaskCount, getPlan, listCreditPacks, listPlans, planForUser } from '../services/plans.js';
import {
  activeGateway,
  applyWebhookEvent,
  auditPaidOrder,
  checkoutReplayPayUrl,
  gatewayStatus,
  missingPayUrlColumn,
  type OrderRow,
} from '../services/payments.js';
import { env } from '../env.js';

/** Recharge and mock payment are owner-only. API keys arrive as editor. */
export function assertBillingOwner(role: string | undefined): void {
  if (role !== 'owner') throw forbidden('权限不足');
}

function replayCheckout(order: OrderRow) {
  return {
    item: toOrderDto(order),
    payUrl: checkoutReplayPayUrl(order, env.payments.publicBaseUrl),
    idempotent: true as const,
  };
}

/** 结账没留下支付单号和链接时放开键。订单行保留，已写下的单号或链接不动。 */
async function releaseCheckoutIdempotency(
  orderId: string,
  order: Pick<OrderRow, 'status' | 'provider_order_id' | 'pay_url'> | null,
  reason: { gatewayFailed: boolean; fieldProblem: string | null; writeFailed?: boolean },
): Promise<void> {
  if (
    !shouldReleaseCheckoutIdempotency({
      gatewayFailed: reason.gatewayFailed,
      fieldProblem: reason.fieldProblem,
      writeFailed: reason.writeFailed ?? false,
      status: order?.status ?? 'pending',
      providerOrderId: order?.provider_order_id ?? null,
      payUrl: order?.pay_url ?? null,
    })
  ) {
    return;
  }

  try {
    await exec(
      `UPDATE orders SET idempotency_key = NULL
       WHERE id = ? AND status = 'pending'
         AND (provider_order_id IS NULL OR provider_order_id = '')
         AND (pay_url IS NULL OR pay_url = '')`,
      [orderId],
    );
  } catch (err) {
    if (!missingPayUrlColumn(err)) throw err;
    await exec(
      `UPDATE orders SET idempotency_key = NULL
       WHERE id = ? AND status = 'pending'
         AND (provider_order_id IS NULL OR provider_order_id = '')`,
      [orderId],
    );
  }
}

function toOrderDto(o: OrderRow) {
  return {
    id: o.id,
    kind: o.kind,
    skuId: o.sku_id,
    skuName: o.sku_name,
    amountCents: Number(o.amount_cents),
    credits: Number(o.credits),
    status: o.status,
    provider: o.provider,
    paidAt: o.paid_at ? toMillis(o.paid_at) : null,
    expiresAt: toMillis(o.expires_at),
    createdAt: toMillis(o.created_at),
  };
}

export async function billingRoutes(app: FastifyInstance) {
  // ── Public catalogue ───────────────────────────────────────────────────
  app.get('/api/billing/catalogue', async () => {
    const [plans, packs] = await Promise.all([listPlans(), listCreditPacks()]);
    return { plans, packs, gateway: gatewayStatus() };
  });

  /** The caller's current entitlement + live quota usage. */
  app.get('/api/billing/subscription', { preHandler: [requireAuth] }, async (req) => {
    const plan = await planForUser(req.userId!);
    const active = await activeTaskCount(req.userId!);
    const row = await queryOne<{ plan_id: string | null; plan_expires_at: string | null }>(
      'SELECT plan_id, plan_expires_at FROM users WHERE id = ?',
      [req.userId!],
    );
    return {
      plan,
      activeTasks: active,
      concurrencyLeft: Math.max(0, plan.maxConcurrent - active),
      planId: row?.plan_id ?? 'free',
      planExpiresAt: row?.plan_expires_at ? toMillis(row.plan_expires_at) : null,
    };
  });

  // ── Checkout ───────────────────────────────────────────────────────────
  const checkoutSchema = z.object({
    kind: z.enum(['plan', 'credits']),
    skuId: z.string().trim().min(1).max(32),
  });

  /**
   * Creates an order. The client sends ONLY a sku id — price and credited
   * amount are read from the server catalogue. A tampered client cannot buy
   * 100k credits for ¥1.
   */
  app.post('/api/billing/checkout', { preHandler: [requireAuth] }, async (req, reply) => {
    assertBillingOwner(req.role);

    // 合法键且已有本用户订单时先重放：不占下单限流，也不看网关是否已配置。
    // 超长键这里不报错，仍落到下面的限流之后。
    const replayKey = idempotencyKeyFromHeader(req.headers['idempotency-key']);
    if (replayKey.key) {
      const existing = await queryOne<OrderRow>(
        'SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ? LIMIT 1',
        [req.userId!, replayKey.key],
      );
      if (existing) return reply.code(200).send(replayCheckout(existing));
    }

    await checkRateLimit(`checkout:u:${req.userId}`, 10, 60, '下单过于频繁，请稍后再试');

    // 超长键在限流之后立刻拒绝，不再解析请求体、检查网关或查套餐。
    if (replayKey.error) throw badRequest(replayKey.error);

    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const bodyMessage = checkoutBodyMessage(issue?.path[0]);
      throw badRequest(bodyMessage ?? issue?.message ?? '参数错误');
    }
    const { kind, skuId } = parsed.data;

    const gw = activeGateway();
    if (!gw) {
      return reply.code(503).send({
        error: 'PAYMENT_NOT_CONFIGURED',
        message: '支付通道未配置，请联系管理员',
      });
    }

    let amountCents: number;
    let credits: number;
    let skuName: string;

    if (kind === 'plan') {
      const plan = await getPlan(skuId);
      if (!plan) throw badRequest('套餐不存在或已下架');
      if (plan.priceCents <= 0) throw badRequest('该套餐无需购买');
      amountCents = plan.priceCents;
      credits = plan.monthlyCredits ?? 0;
      skuName = plan.name;
    } else {
      const packs = await listCreditPacks();
      const pack = packs.find((p) => p.id === skuId);
      if (!pack) throw badRequest('充值包不存在或已下架');
      amountCents = pack.priceCents;
      credits = pack.credits + pack.bonus;
      skuName = pack.name;
    }

    const parsedIdempotency = idempotencyKeyFromHeader(req.headers['idempotency-key']);
    if (parsedIdempotency.error) throw badRequest(parsedIdempotency.error);
    const idempotencyKey = parsedIdempotency.key;

    if (idempotencyKey) {
      const existing = await queryOne<OrderRow>(
        'SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ? LIMIT 1',
        [req.userId!, idempotencyKey],
      );
      if (existing) return reply.code(200).send(replayCheckout(existing));
    }

    const id = randomUUID();
    const expiresAt = new Date(Date.now() + env.payments.orderTtlMinutes * 60_000);

    try {
      await exec(
        `INSERT INTO orders (id, org_id, user_id, kind, sku_id, sku_name, amount_cents, credits, status, provider, expires_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [
          id,
          req.orgId ?? null,
          req.userId!,
          kind,
          skuId,
          skuName,
          amountCents,
          credits,
          gw.id,
          expiresAt,
          idempotencyKey,
        ],
      );
    } catch (err) {
      if ((err as { code?: string })?.code === 'ER_DUP_ENTRY' && idempotencyKey) {
        const raced = await queryOne<OrderRow>(
          'SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ? LIMIT 1',
          [req.userId!, idempotencyKey],
        );
        if (raced) return reply.code(200).send(replayCheckout(raced));
      }
      throw err;
    }

    const order = await queryOne<OrderRow>('SELECT * FROM orders WHERE id = ?', [id]);
    let created: { providerOrderId: string; payUrl: string };
    try {
      created = await gw.create(order!);
    } catch (err) {
      await releaseCheckoutIdempotency(id, order, { gatewayFailed: true, fieldProblem: null });
      throw err;
    }
    const checkoutProblem = checkoutFieldProblem(created.providerOrderId, created.payUrl);
    if (checkoutProblem) {
      await releaseCheckoutIdempotency(id, order, { gatewayFailed: false, fieldProblem: checkoutProblem });
      throw badRequest(checkoutProblem);
    }
    try {
      await exec('UPDATE orders SET provider_order_id = ?, pay_url = ? WHERE id = ?', [
        created.providerOrderId,
        created.payUrl,
        id,
      ]);
    } catch (err) {
      if (!missingPayUrlColumn(err)) {
        await releaseCheckoutIdempotency(id, order, {
          gatewayFailed: false,
          fieldProblem: null,
          writeFailed: true,
        });
        throw err;
      }
      try {
        await exec('UPDATE orders SET provider_order_id = ? WHERE id = ?', [created.providerOrderId, id]);
      } catch (fallbackErr) {
        await releaseCheckoutIdempotency(id, order, {
          gatewayFailed: false,
          fieldProblem: null,
          writeFailed: true,
        });
        throw fallbackErr;
      }
    }

    await audit({
      userId: req.userId!,
      orgId: req.orgId,
      action: 'billing.create_order',
      target: id,
      meta: { kind, skuId, amountCents, credits, provider: gw.id },
    });

    return reply.code(201).send({
      item: toOrderDto({ ...order!, provider_order_id: created.providerOrderId }),
      payUrl: created.payUrl,
    });
  });

  app.get('/api/billing/orders', { preHandler: [requireAuth] }, async (req) => {
    const { limit, before, beforeId } = req.query as {
      limit?: unknown;
      before?: unknown;
      beforeId?: unknown;
    };
    const page = parseGenerationPage({
      limit: limit === undefined || limit === null || limit === '' ? '100' : limit,
      before,
      beforeId,
    });
    if (page.error) throw badRequest(page.error);

    // Lazily expire abandoned orders so the UI never shows a stale "待支付".
    await exec(
      "UPDATE orders SET status = 'expired' WHERE user_id = ? AND status = 'pending' AND expires_at < UTC_TIMESTAMP()",
      [req.userId!],
    );

    const cursor = generationCursorSql(page.cursor);
    const rows = await query<OrderRow>(
      `SELECT * FROM orders WHERE user_id = ? ${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
      [req.userId!, ...cursor.params, page.limit],
    );

    const last = rows.length === page.limit ? rows[rows.length - 1] : null;
    const stamp = last ? cursorStamp(last.created_at) : null;
    return {
      items: rows.map(toOrderDto),
      nextCursor: last && stamp ? { createdAt: stamp, id: last.id } : null,
    };
  });

  // ── Webhook (source of truth) ──────────────────────────────────────────
  /**
   * Must receive the RAW body: any JSON re-serialization changes bytes and
   * breaks signature verification. A dedicated encapsulated context installs a
   * string parser so the other billing routes keep normal JSON parsing.
   */
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });

    scope.post('/api/billing/webhook/:provider', async (req, reply) => {
      const { provider } = req.params as { provider: string };
      if (provider !== env.payments.provider) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: '未知支付通道' });
      }

      const gw = activeGateway();
      if (!gw) {
        return reply.code(503).send({ error: 'PAYMENT_NOT_CONFIGURED', message: '支付通道未配置' });
      }

      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
      const event = await gw.parseWebhook(rawBody, req.headers as any);
      const result = await applyWebhookEvent(provider, event, safeParse(rawBody));

      if (result.outcome === 'processed' && result.order) {
        await auditPaidOrder(result.order, provider);
      }

      // Always 200 for duplicates/ignored: a non-2xx makes gateways retry
      // forever, and there is nothing to retry.
      return reply.send({ ok: true, outcome: result.outcome });
    });
  });

  /**
   * Dev-only completion endpoint used by the mock gateway's `payUrl`.
   * Guarded three ways: mock gateway must be active, a valid signature is
   * still required, and production refuses to register the mock gateway.
   */
  app.post('/api/billing/mock/pay', { preHandler: [requireAuth] }, async (req, reply) => {
    assertBillingOwner(req.role);
    const gw = activeGateway();
    if (!gw?.mock) throw notFound('模拟支付不可用');
    if (!env.payments.webhookSecret) {
      throw badRequest('PAYMENT_WEBHOOK_SECRET 未配置，无法模拟支付');
    }

    const body = z.object({ orderId: z.string().uuid() }).safeParse(req.body);
    if (!body.success) throw badRequest('参数错误');

    const order = await queryOne<OrderRow>('SELECT * FROM orders WHERE id = ? AND user_id = ?', [
      body.data.orderId,
      req.userId!,
    ]);
    if (!order) throw notFound('订单不存在');
    if (order.status === 'paid') return { ok: true, outcome: 'duplicate' };
    if (order.status !== 'pending') throw badRequest(`订单状态为 ${order.status}，无法支付`);

    const { signPayload } = await import('../services/payments.js');
    const rawBody = JSON.stringify({
      eventId: `mock-evt-${randomUUID()}`,
      orderId: order.id,
      type: 'paid',
      txnId: `mock-txn-${randomUUID()}`,
    });
    const signature = signPayload(env.payments.webhookSecret, rawBody);
    const event = await gw.parseWebhook(rawBody, { 'x-mock-signature': signature });
    const result = await applyWebhookEvent(gw.id, event, safeParse(rawBody));
    if (result.outcome === 'processed' && result.order) await auditPaidOrder(result.order, gw.id);

    return reply.send({ ok: true, outcome: result.outcome });
  });

  // ── Admin: order ledger ────────────────────────────────────────────────
  app.get(
    '/api/admin/orders',
    { preHandler: [requireAuth, requireOrg, requireRole('owner', 'admin')] },
    async (req) => {
      const raw = req.query as {
        status?: unknown;
        limit?: unknown;
        before?: unknown;
        beforeId?: unknown;
      };
      const q = parseAdminOrderQuery(raw);
      if (q.error) throw badRequest(q.error);
      const page = parseGenerationPage({
        limit: q.limit,
        before: raw.before,
        beforeId: raw.beforeId,
      });
      if (page.error) throw badRequest(page.error);

      await exec(
        "UPDATE orders SET status = 'expired' WHERE org_id = ? AND status = 'pending' AND expires_at < UTC_TIMESTAMP()",
        [req.orgId!],
      );

      const where: string[] = ['org_id = ?'];
      const params: any[] = [req.orgId!];
      if (q.status) {
        where.push('status = ?');
        params.push(q.status);
      }
      const cursor = generationCursorSql(page.cursor);
      const rows = await query<any>(
        `SELECT * FROM orders WHERE ${where.join(' AND ')} ${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
        [...params, ...cursor.params, page.limit],
      );

      const [totals] = await query<any>(
        `SELECT
           SUM(status = 'paid') AS paid_count,
           COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END), 0) AS revenue_cents,
           COALESCE(SUM(CASE WHEN status = 'paid' THEN credits ELSE 0 END), 0) AS credits_sold
         FROM orders WHERE org_id = ?`,
        [req.orgId!],
      );

      const last = rows.length === page.limit ? rows[rows.length - 1] : null;
      const stamp = last ? cursorStamp(last.created_at) : null;
      return {
        items: rows.map((r) => ({
          ...toOrderDto(r as OrderRow),
          userId: r.user_id,
          orgId: r.org_id,
        })),
        totals: {
          paidCount: Number(totals?.paid_count ?? 0),
          revenueCents: Number(totals?.revenue_cents ?? 0),
          creditsSold: Number(totals?.credits_sold ?? 0),
        },
        nextCursor: last && stamp ? { createdAt: stamp, id: last.id } : null,
      };
    },
  );

  /**
   * Paid orders must equal the credits they granted, and every paid order needs a
   * processed payment event. Each list is a sample of at most 100 rows. `counts`
   * is the full size of that same filtered set, and `ok` is true only when both
   * counts are zero.
   */
  app.get(
    '/api/admin/billing/reconcile',
    { preHandler: [requireAuth, requireOrg, requireRole('owner', 'admin')] },
    async (req) => {
      const orgId = req.orgId!;
      const creditedSql = `COALESCE((SELECT SUM(t.delta) FROM credit_transactions t
                           WHERE t.ref_id = o.id AND t.reason LIKE '充值到账%'), 0)`;
      const mismatchBody = `FROM orders o
          WHERE o.org_id = ? AND o.status = 'paid'
         HAVING o.credits <> credited`;
      const webhookBody = `FROM orders o
          WHERE o.org_id = ? AND o.status = 'paid'
            AND NOT EXISTS (SELECT 1 FROM payment_events e WHERE e.order_id = o.id AND e.outcome = 'processed')`;

      const [mismatchCount] = await query<any>(
        `SELECT COUNT(*) AS c FROM (
           SELECT o.credits, ${creditedSql} AS credited
           ${mismatchBody}
         ) mismatch_count`,
        [orgId],
      );
      const mismatched = await query<any>(
        `SELECT o.id, o.sku_id, o.credits, o.paid_at, ${creditedSql} AS credited
           ${mismatchBody}
          LIMIT 100`,
        [orgId],
      );

      const [webhookCount] = await query<any>(`SELECT COUNT(*) AS c ${webhookBody}`, [orgId]);
      const paidWithoutEvent = await query<any>(`SELECT o.id, o.sku_id ${webhookBody} LIMIT 100`, [orgId]);

      const counts = {
        creditMismatch: Number(mismatchCount?.c ?? 0),
        paidWithoutWebhook: Number(webhookCount?.c ?? 0),
      };

      return {
        ok: counts.creditMismatch === 0 && counts.paidWithoutWebhook === 0,
        counts,
        creditMismatch: mismatched.map((r) => ({
          orderId: r.id,
          skuId: r.sku_id,
          ordered: Number(r.credits),
          credited: Number(r.credited),
        })),
        paidWithoutWebhook: paidWithoutEvent.map((r) => ({ orderId: r.id, skuId: r.sku_id })),
      };
    },
  );
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
