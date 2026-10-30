import { timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { toMillis } from '../lib/dto.js';
import { ApiError } from '../lib/errors.js';
import { registerGateway, signPayload, type Gateway, type WebhookEvent } from './payments.js';

const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const DEFAULT_API_BASE = 'https://api.stripe.com';

export type StripeGatewayOptions = {
  secretKey: string;
  webhookSecret: string;
  /** Checkout API origin. Tests point this at a local server. */
  apiBase?: string;
  publicBaseUrl: string;
};

export type StripeInstallConfig = {
  provider: string;
  secretKey: string;
  webhookSecret: string;
  apiBase?: string;
  publicBaseUrl: string;
};

/**
 * Registers Stripe only for an explicit stripe provider with both secrets.
 * A missing key leaves the registry unchanged (mock stays the default).
 */
export function installStripeGateway(config: StripeInstallConfig): boolean {
  if (config.provider !== 'stripe') return false;
  const secretKey = config.secretKey.trim();
  const webhookSecret = config.webhookSecret.trim();
  if (!secretKey || !webhookSecret) return false;
  registerGateway(
    createStripeGateway({
      secretKey,
      webhookSecret,
      apiBase: config.apiBase,
      publicBaseUrl: config.publicBaseUrl,
    }),
  );
  return true;
}

/** Startup hook. Reads env and no-ops unless Stripe is fully configured. */
export function installConfiguredStripeGateway(): boolean {
  return installStripeGateway({
    provider: env.payments.provider,
    secretKey: env.payments.stripe.secretKey,
    webhookSecret: env.payments.stripe.webhookSecret,
    apiBase: env.payments.stripe.apiBase,
    publicBaseUrl: env.payments.publicBaseUrl,
  });
}

export function createStripeGateway(options: StripeGatewayOptions): Gateway {
  const secretKey = options.secretKey.trim();
  const webhookSecret = options.webhookSecret.trim();
  const apiBase = (options.apiBase || DEFAULT_API_BASE).trim().replace(/\/+$/, '') || DEFAULT_API_BASE;
  const publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '');

  return {
    id: 'stripe',
    mock: false,
    async create(order) {
      // Price comes from the order row. The webhook must not be able to
      // substitute a client-supplied amount or credit count.
      const providerOrderId = `stripe_${order.id}`;
      const body = formBody([
        ['mode', 'payment'],
        ['client_reference_id', providerOrderId],
        ['success_url', `${publicBaseUrl}/?billing=success&session_id={CHECKOUT_SESSION_ID}`],
        ['cancel_url', `${publicBaseUrl}/?billing=cancel`],
        ['metadata[provider_order_id]', providerOrderId],
        ['line_items[0][quantity]', '1'],
        ['line_items[0][price_data][currency]', 'cny'],
        ['line_items[0][price_data][unit_amount]', String(order.amount_cents)],
        ['line_items[0][price_data][product_data][name]', order.sku_name],
        ['payment_method_types[0]', 'card'],
      ]);

      let response: Response;
      try {
        response = await fetch(`${apiBase}/v1/checkout/sessions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Idempotency-Key': providerOrderId,
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Stripe Checkout request failed';
        throw new ApiError(502, message, 'PAYMENT_PROVIDER_ERROR');
      }

      if (!response.ok) {
        throw new ApiError(502, 'Stripe Checkout 创建失败', 'PAYMENT_PROVIDER_ERROR');
      }

      let payload: { url?: unknown };
      try {
        payload = (await response.json()) as { url?: unknown };
      } catch {
        throw new ApiError(502, 'Stripe Checkout 返回了无法解析的响应', 'PAYMENT_PROVIDER_ERROR');
      }
      if (typeof payload.url !== 'string' || !payload.url) {
        throw new ApiError(502, 'Stripe Checkout 未返回支付链接', 'PAYMENT_PROVIDER_ERROR');
      }

      return {
        providerOrderId,
        payUrl: payload.url,
        expiresAt: toMillis(order.expires_at),
      };
    },

    async parseWebhook(rawBody, headers): Promise<WebhookEvent> {
      if (!webhookSecret) {
        throw new ApiError(503, 'STRIPE_WEBHOOK_SECRET is not configured', 'PAYMENT_NOT_CONFIGURED');
      }
      verifyStripeSignature(rawBody, headers, webhookSecret);
      return normalizeEvent(rawBody);
    },
  };
}

function formBody(fields: Array<[string, string]>): string {
  return fields
    .map(([key, value]) => {
      // Stripe substitutes {CHECKOUT_SESSION_ID} only when the braces are literal.
      const encoded = encodeURIComponent(value).replace(/%7B/gi, '{').replace(/%7D/gi, '}');
      return `${encodeURIComponent(key)}=${encoded}`;
    })
    .join('&');
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0] ?? '';
    return value ?? '';
  }
  return '';
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Stripe-Signature: t=<unix seconds>,v1=<hex hmac sha256 of `${t}.${rawBody}`>.
 * The signature is checked before the 5-minute window so a bad MAC is never
 * reported as merely expired.
 */
function verifyStripeSignature(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  webhookSecret: string,
): void {
  const header = headerValue(headers, 'stripe-signature');
  let timestampRaw = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === 't') timestampRaw = value;
    else if (key === 'v1' && value) signatures.push(value);
  }

  if (!/^\d+$/.test(timestampRaw) || signatures.length === 0) {
    throw new ApiError(401, 'Webhook signature verification failed', 'PAYMENT_BAD_SIGNATURE');
  }

  const expected = signPayload(webhookSecret, `${timestampRaw}.${rawBody}`);
  let matched = false;
  for (const candidate of signatures) {
    if (safeEqual(expected, candidate)) matched = true;
  }
  if (!matched) {
    throw new ApiError(401, 'Webhook signature verification failed', 'PAYMENT_BAD_SIGNATURE');
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestampRaw));
  if (age > STRIPE_SIGNATURE_TOLERANCE_SECONDS) {
    throw new ApiError(401, 'Webhook timestamp is outside the 5 minute tolerance', 'PAYMENT_TIMESTAMP_EXPIRED');
  }
}

/**
 * Maps a Checkout event onto the local order id we stored at create time.
 * amount_total, metadata.amount, and metadata.credits are ignored: crediting
 * happens later from the order row inside applyWebhookEvent.
 */
function normalizeEvent(rawBody: string): WebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ApiError(400, 'Webhook payload is missing required fields', 'BAD_REQUEST');
  }

  const event = asRecord(parsed);
  const eventId = typeof event?.id === 'string' ? event.id.trim() : '';
  const type = typeof event?.type === 'string' ? event.type : '';
  const session = asRecord(asRecord(event?.data)?.object);
  const providerOrderId = readProviderOrderId(session);
  const eventType = type === 'checkout.session.completed' ? 'paid' : 'other';

  if (!eventId || (eventType === 'paid' && !providerOrderId)) {
    throw new ApiError(400, 'Webhook payload is missing required fields', 'BAD_REQUEST');
  }

  return {
    eventId,
    providerOrderId: providerOrderId || `stripe_unmatched_${eventId}`,
    eventType,
    txnId: readTxnId(session),
  };
}

function readProviderOrderId(session: Record<string, unknown> | null): string {
  if (!session) return '';
  const reference = session.client_reference_id;
  if (typeof reference === 'string' && reference.trim()) return reference.trim();
  const metadata = asRecord(session.metadata);
  const fromMetadata = metadata?.provider_order_id;
  if (typeof fromMetadata === 'string' && fromMetadata.trim()) return fromMetadata.trim();
  return '';
}

function readTxnId(session: Record<string, unknown> | null): string | null {
  if (!session) return null;
  const paymentIntent = session.payment_intent;
  if (typeof paymentIntent === 'string' && paymentIntent.trim()) return paymentIntent.trim();
  const expanded = asRecord(paymentIntent);
  if (typeof expanded?.id === 'string' && expanded.id.trim()) return expanded.id.trim();
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
