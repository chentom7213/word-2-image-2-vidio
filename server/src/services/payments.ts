import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { queryOne, withTransaction } from '../db/pool.js';
import { env } from '../env.js';
import { toMillis } from '../lib/dto.js';
import { ApiError } from '../lib/errors.js';
import { storedPaymentEventId, storedPaymentPayload, storedPaymentTxnId } from '../lib/payment-column.js';
import { adjustCredits } from './credits.js';
import { getPlan } from './plans.js';
import { audit } from './audit.js';
import { recordInitialPlanGrant } from './monthlyCredits.js';

/**
 * Payment gateway abstraction.
 *
 * A webhook is the sole source of truth for "money arrived", never the browser
 * redirect (the client controls that).
 *
 * Two properties are non-negotiable:
 *   1. Webhooks are idempotent. Gateways retry aggressively; a retry must not
 *      credit twice.
 *   2. The amount credited comes from the order row, never from the payload,
 *      so a forged webhook cannot inflate the credited credits.
 */

export type OrderRow = {
  id: string;
  org_id: string | null;
  user_id: string;
  kind: 'plan' | 'credits';
  sku_id: string;
  sku_name: string;
  amount_cents: number;
  credits: number;
  status: 'pending' | 'paid' | 'failed' | 'refunded' | 'expired';
  provider: string | null;
  provider_order_id: string | null;
  pay_url?: string | null;
  provider_txn_id: string | null;
  idempotency_key: string | null;
  paid_at: string | null;
  expires_at: string;
  created_at: string;
};

export type CreateResult = { providerOrderId: string; payUrl: string; expiresAt: number };

export type WebhookEvent = {
  /** Gateway-side unique event id: the idempotency key. */
  eventId: string;
  /** Gateway-side order reference we generated at checkout. */
  providerOrderId: string;
  eventType: 'paid' | 'failed' | 'refunded' | 'other';
  /** Gateway transaction id, kept for financial reconciliation. */
  txnId: string | null;
};

export type Gateway = {
  readonly id: string;
  /** True only for the local simulator; refused in production. */
  readonly mock: boolean;
  create(order: OrderRow): Promise<CreateResult>;
  /** Verifies the signature and normalizes the payload. Throws on bad signature. */
  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent>;
};

/** Pending replay returns the stored gateway link. Only mock orders rebuild a local one. */
export function checkoutReplayPayUrl(
  order: Pick<OrderRow, 'id' | 'status' | 'provider' | 'pay_url'>,
  publicBaseUrl: string,
): string | null {
  if (order.status !== 'pending') return null;
  const stored = typeof order.pay_url === 'string' ? order.pay_url.trim() : '';
  if (stored) return stored;
  if (order.provider === 'mock') {
    const base = publicBaseUrl.replace(/\/+$/, '');
    return `${base}/api/billing/mock/pay?order=${order.id}`;
  }
  return null;
}

export function missingPayUrlColumn(err: unknown): boolean {
  const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : '';
  const message = err instanceof Error ? err.message : String(err ?? '');
  return code === 'ER_BAD_FIELD_ERROR' || message.includes('pay_url');
}

export function signPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Local simulator. Lets the whole purchase flow be exercised end to end
 * (checkout -> webhook -> credits) with no merchant account.
 *
 * Deliberately NOT registered when NODE_ENV=production: anyone able to reach
 * this webhook could otherwise mint unlimited credits.
 */
const mockGateway: Gateway = {
  id: 'mock',
  mock: true,
  async create(order) {
    return {
      providerOrderId: `mock_${order.id}`,
      payUrl: `${env.payments.publicBaseUrl}/api/billing/mock/pay?order=${order.id}`,
      expiresAt: toMillis(order.expires_at),
    };
  },
  async parseWebhook(rawBody, headers) {
    const secret = env.payments.webhookSecret;
    if (!secret) {
      throw new ApiError(503, 'PAYMENT_WEBHOOK_SECRET is not configured', 'PAYMENT_NOT_CONFIGURED');
    }

    const signature = String(headers['x-mock-signature'] ?? '');
    if (!signature || !safeEqual(signPayload(secret, rawBody), signature)) {
      throw new ApiError(401, 'Webhook signature verification failed', 'PAYMENT_BAD_SIGNATURE');
    }

    const parsed = JSON.parse(rawBody) as {
      eventId?: string;
      orderId?: string;
      type?: string;
      txnId?: string;
    };
    if (!parsed.eventId || !parsed.orderId) {
      throw new ApiError(400, 'Webhook payload is missing required fields', 'BAD_REQUEST');
    }
    return {
      eventId: parsed.eventId,
      providerOrderId: `mock_${parsed.orderId}`,
      eventType: parsed.type === 'paid' ? 'paid' : parsed.type === 'failed' ? 'failed' : 'other',
      txnId: parsed.txnId ?? null,
    };
  },
};

const gateways = new Map<string, Gateway>();

const MOCK_ALLOWED = !(process.env.NODE_ENV === 'production' && env.payments.provider === 'mock');
if (MOCK_ALLOWED) gateways.set('mock', mockGateway);

export function registerGateway(gw: Gateway) {
  gateways.set(gw.id, gw);
}

export function findGateway(id: string): Gateway | null {
  return gateways.get(id) ?? null;
}

/** Removes a real gateway. The mock simulator stays registered outside production. */
export function unregisterGateway(id: string): void {
  if (id === 'mock') return;
  gateways.delete(id);
}

export function activeGateway(): Gateway | null {
  return gateways.get(env.payments.provider) ?? null;
}

export function gatewayStatus(): { provider: string; configured: boolean; mock: boolean } {
  const gw = activeGateway();
  return { provider: env.payments.provider, configured: Boolean(gw), mock: Boolean(gw?.mock) };
}

/**
 * Applies a verified webhook event.
 *
 * The payment_events unique key is the idempotency guard: it is inserted in the
 * SAME transaction that moves money, so a replayed event fails with a
 * duplicate-key error and rolls back. Credits are granted exactly once.
 */
export async function applyWebhookEvent(
  provider: string,
  event: WebhookEvent,
  payload: unknown,
): Promise<{ outcome: 'processed' | 'duplicate' | 'ignored'; order?: OrderRow }> {
  const order = await queryOne<OrderRow>(
    'SELECT * FROM orders WHERE provider = ? AND provider_order_id = ? LIMIT 1',
    [provider, event.providerOrderId],
  );

  const eventRowId = randomUUID();

  try {
    return await withTransaction(async (conn) => {
      await conn.query(
        'INSERT INTO payment_events (id, provider, event_id, order_id, event_type, payload, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          eventRowId,
          provider,
          storedPaymentEventId(event.eventId),
          order?.id ?? null,
          event.eventType,
          storedPaymentPayload(payload),
          'processed',
        ],
      );

      if (!order) {
        await conn.query('UPDATE payment_events SET outcome = ? WHERE id = ?', ['ignored', eventRowId]);
        return { outcome: 'ignored' as const };
      }

      if (event.eventType === 'failed') {
        await conn.query("UPDATE orders SET status = 'failed' WHERE id = ? AND status = 'pending'", [
          order.id,
        ]);
        return { outcome: 'processed' as const, order };
      }

      if (event.eventType !== 'paid') {
        await conn.query('UPDATE payment_events SET outcome = ? WHERE id = ?', ['ignored', eventRowId]);
        return { outcome: 'ignored' as const };
      }

      // CAS: only a still-pending order may become paid. This closes the race
      // where two DIFFERENT events both claim to pay the same order.
      const [res] = await conn.query<any>(
        `UPDATE orders
            SET status = 'paid', paid_at = UTC_TIMESTAMP(), provider_txn_id = ?
          WHERE id = ? AND status = 'pending'`,
        [storedPaymentTxnId(event.txnId), order.id],
      );
      if (res.affectedRows !== 1) {
        await conn.query('UPDATE payment_events SET outcome = ? WHERE id = ?', ['duplicate', eventRowId]);
        return { outcome: 'duplicate' as const, order };
      }

      // Credits come from the ORDER ROW, never the webhook payload.
      const totalCredits = Number(order.credits);
      if (totalCredits > 0) {
        await adjustCredits(conn, order.user_id, totalCredits, `充值到账 · ${order.sku_name}`, order.id);
      }

      // A plan purchase extends entitlement (stacking, never shortening).
      if (order.kind === 'plan') {
        const plan = await getPlan(order.sku_id);
        if (plan) {
          // The paid order is the first monthly grant's durable anchor.  The
          // scheduled runner uses this record to avoid issuing it again early.
          await recordInitialPlanGrant(conn, {
            userId: order.user_id,
            planId: plan.id,
            credits: totalCredits,
            orderId: order.id,
          });
          await conn.query(
            `UPDATE users
                SET plan_id = ?,
                    plan_expires_at = DATE_ADD(GREATEST(COALESCE(plan_expires_at, UTC_TIMESTAMP()), UTC_TIMESTAMP()), INTERVAL 30 DAY)
              WHERE id = ?`,
            [plan.id, order.user_id],
          );
        }
      }

      const [rows] = await conn.query<any[]>('SELECT * FROM orders WHERE id = ?', [order.id]);
      return { outcome: 'processed' as const, order: rows[0] as OrderRow };
    });
  } catch (err: any) {
    if (String(err?.code ?? '') === 'ER_DUP_ENTRY') return { outcome: 'duplicate' };
    throw err;
  }
}

/** Audit is written outside the money transaction so it cannot roll it back. */
export async function auditPaidOrder(order: OrderRow, provider: string) {
  await audit({
    userId: order.user_id,
    orgId: order.org_id,
    action: 'billing.paid',
    target: order.id,
    meta: {
      sku: order.sku_id,
      credits: Number(order.credits),
      amountCents: Number(order.amount_cents),
      provider,
    },
  });
}
