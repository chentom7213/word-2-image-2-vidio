import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/env.js';
import { activeGateway, findGateway, unregisterGateway, type OrderRow } from '../src/services/payments.js';
import {
  createStripeGateway,
  installConfiguredStripeGateway,
  installStripeGateway,
} from '../src/services/stripe-gateway.js';

const SECRET = 'whsec_unit';
const API_KEY = 'sk_test_local';
const closers: Array<() => Promise<void>> = [];
const originalProvider = env.payments.provider;

afterEach(async () => {
  unregisterGateway('stripe');
  env.payments.provider = originalProvider;
  while (closers.length) {
    const close = closers.pop();
    if (close) await close();
  }
});

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: '6f1e8c2a-9b34-4d5e-a1c2-000000000001',
    org_id: null,
    user_id: 'user-1',
    kind: 'credits',
    sku_id: 'pack-1',
    sku_name: 'Starter pack',
    amount_cents: 3900,
    credits: 5500,
    status: 'pending',
    provider: 'stripe',
    provider_order_id: null,
    provider_txn_id: null,
    idempotency_key: null,
    paid_at: null,
    expires_at: '2026-10-26T15:00:00.000Z',
    created_at: '2026-10-26T14:00:00.000Z',
    ...overrides,
  };
}

function stripeSignature(secret: string, rawBody: string, timestamp: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

function completedEvent(providerOrderId: string): string {
  return JSON.stringify({
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    amount: 1,
    credits: 999999,
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        client_reference_id: providerOrderId,
        payment_intent: 'pi_test_1',
        amount_total: 1,
        amount_subtotal: 1,
        metadata: { credits: '999999', amount: '1', provider_order_id: providerOrderId },
      },
    },
  });
}

function gateway() {
  return createStripeGateway({
    secretKey: API_KEY,
    webhookSecret: SECRET,
    apiBase: 'http://127.0.0.1:9',
    publicBaseUrl: 'http://127.0.0.1:4000',
  });
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function startMock(handler: (req: IncomingMessage, res: ServerResponse, rawBody: string) => void) {
  const requests: Array<{ method: string; url: string; rawBody: string; authorization?: string; host?: string }> = [];
  const server = createServer(async (req, res) => {
    const rawBody = await readRaw(req);
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      rawBody,
      authorization: req.headers.authorization,
      host: req.headers.host,
    });
    handler(req, res, rawBody);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('mock server has no port');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections();
    });
  closers.push(close);
  return { baseUrl, requests, close };
}

describe('stripe webhook signatures', () => {
  it('rejects a signature that is not the HMAC of timestamp and raw body', async () => {
    const gw = gateway();
    const raw = completedEvent('stripe_order-1');
    const timestamp = Math.floor(Date.now() / 1000);
    const signedWithoutPrefix = createHmac('sha256', SECRET).update(raw).digest('hex');

    await expect(
      gw.parseWebhook(raw, { 'stripe-signature': `t=${timestamp},v1=${signedWithoutPrefix}` }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'PAYMENT_BAD_SIGNATURE' });
  });

  it('rejects a correctly signed event older than five minutes', async () => {
    const gw = gateway();
    const raw = completedEvent('stripe_order-1');
    const timestamp = Math.floor(Date.now() / 1000) - 5 * 60 - 30;

    await expect(
      gw.parseWebhook(raw, { 'stripe-signature': stripeSignature(SECRET, raw, timestamp) }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'PAYMENT_TIMESTAMP_EXPIRED' });
  });

  it('parses checkout.session.completed into the local provider order id', async () => {
    const gw = gateway();
    const providerOrderId = 'stripe_6f1e8c2a-9b34-4d5e-a1c2-000000000001';
    const raw = completedEvent(providerOrderId);
    const timestamp = Math.floor(Date.now() / 1000);

    const event = await gw.parseWebhook(raw, { 'stripe-signature': stripeSignature(SECRET, raw, timestamp) });

    expect(event).toEqual({
      eventId: 'evt_test_1',
      providerOrderId,
      eventType: 'paid',
      txnId: 'pi_test_1',
    });
    expect(JSON.stringify(event)).not.toContain('999999');
    expect(JSON.stringify(event)).not.toContain('"amount"');
  });
});

describe('stripe gateway registration', () => {
  it('keeps mock as the default active gateway', () => {
    expect(env.payments.provider).toBe('mock');
    expect(activeGateway()).toMatchObject({ id: 'mock', mock: true });
    expect(findGateway('stripe')).toBeNull();
  });

  it('does not register stripe when the provider stays mock', () => {
    expect(
      installStripeGateway({
        provider: 'mock',
        secretKey: API_KEY,
        webhookSecret: SECRET,
        apiBase: 'http://127.0.0.1:9',
        publicBaseUrl: 'http://127.0.0.1:4000',
      }),
    ).toBe(false);
    expect(findGateway('stripe')).toBeNull();
    expect(activeGateway()).toMatchObject({ id: 'mock', mock: true });
  });

  it('does not register stripe when either secret is empty', () => {
    expect(
      installStripeGateway({
        provider: 'stripe',
        secretKey: '   ',
        webhookSecret: SECRET,
        publicBaseUrl: 'http://127.0.0.1:4000',
      }),
    ).toBe(false);
    expect(
      installStripeGateway({
        provider: 'stripe',
        secretKey: API_KEY,
        webhookSecret: '',
        publicBaseUrl: 'http://127.0.0.1:4000',
      }),
    ).toBe(false);
    expect(findGateway('stripe')).toBeNull();
  });

  it('does not register from the environment when stripe secrets are absent', () => {
    expect(env.payments.stripe.secretKey).toBe('');
    expect(env.payments.stripe.webhookSecret).toBe('');
    expect(installConfiguredStripeGateway()).toBe(false);
    expect(findGateway('stripe')).toBeNull();
    expect(activeGateway()).toMatchObject({ id: 'mock', mock: true });
  });

  it('does not fall back to mock when stripe is selected but secrets are missing', () => {
    env.payments.provider = 'stripe';
    expect(installConfiguredStripeGateway()).toBe(false);
    expect(findGateway('stripe')).toBeNull();
    expect(findGateway('mock')?.mock).toBe(true);
    expect(activeGateway()).toBeNull();
  });

  it('registers a non-mock gateway only when provider is stripe and both secrets are set', () => {
    expect(
      installStripeGateway({
        provider: 'stripe',
        secretKey: API_KEY,
        webhookSecret: SECRET,
        apiBase: 'http://127.0.0.1:9',
        publicBaseUrl: 'http://127.0.0.1:4000',
      }),
    ).toBe(true);
    expect(findGateway('stripe')).toMatchObject({ id: 'stripe', mock: false });
    expect(activeGateway()).toMatchObject({ id: 'mock', mock: true });
  });
});

describe('stripe checkout create', () => {
  it('posts the order amount to a local Checkout endpoint and returns the stripe_ order id', async () => {
    const sample = order();
    const mock = await startMock((_req, res) => {
      const payload = JSON.stringify({ id: 'cs_test_1', url: 'http://127.0.0.1/pay/cs_test_1' });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    });
    const gw = createStripeGateway({
      secretKey: API_KEY,
      webhookSecret: SECRET,
      apiBase: mock.baseUrl,
      publicBaseUrl: 'http://127.0.0.1:4000',
    });

    const created = await gw.create(sample);

    expect(created).toEqual({
      providerOrderId: `stripe_${sample.id}`,
      payUrl: 'http://127.0.0.1/pay/cs_test_1',
      expiresAt: Date.parse(sample.expires_at),
    });
    expect(mock.requests).toHaveLength(1);
    const request = mock.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v1/checkout/sessions');
    expect(request.host?.startsWith('127.0.0.1')).toBe(true);
    expect(request.authorization).toBe(`Bearer ${API_KEY}`);
    const params = new URLSearchParams(request.rawBody);
    const providerOrderId = `stripe_${sample.id}`;
    expect(
      params.get('client_reference_id') === providerOrderId ||
        params.get('metadata[provider_order_id]') === providerOrderId,
    ).toBe(true);
    expect(params.get('line_items[0][price_data][unit_amount]')).toBe(String(sample.amount_cents));
    expect(request.rawBody).not.toContain(String(sample.credits));
    expect(request.rawBody).not.toContain('999999');
  });
});
