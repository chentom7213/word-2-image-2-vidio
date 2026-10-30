import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createSign, generateKeyPairSync, verify } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/env.js';
import { activeGateway, findGateway, unregisterGateway, type OrderRow } from '../src/services/payments.js';
import {
  createAlipayGateway,
  installAlipayGateway,
  installConfiguredAlipayGateway,
  type AlipayInstallConfig,
} from '../src/services/alipay-gateway.js';

const merchant = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const alipay = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const other = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const closers: Array<() => Promise<void>> = [];
const originalProvider = env.payments.provider;
const originalAlipay = { ...env.payments.alipay };

afterEach(async () => {
  unregisterGateway('alipay');
  env.payments.provider = originalProvider;
  env.payments.alipay.appId = originalAlipay.appId;
  env.payments.alipay.privateKey = originalAlipay.privateKey;
  env.payments.alipay.publicKey = originalAlipay.publicKey;
  env.payments.alipay.apiBase = originalAlipay.apiBase;
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
    provider: 'alipay',
    provider_order_id: null,
    provider_txn_id: null,
    idempotency_key: null,
    paid_at: null,
    expires_at: '2026-10-26T15:00:00.000Z',
    created_at: '2026-10-26T14:00:00.000Z',
    ...overrides,
  };
}

function fullConfig(overrides: Partial<AlipayInstallConfig> = {}): AlipayInstallConfig {
  return {
    provider: 'alipay',
    appId: 'app_test_local',
    privateKey: merchant.privateKey,
    alipayPublicKey: alipay.publicKey,
    apiBase: 'http://127.0.0.1:9',
    publicBaseUrl: 'http://127.0.0.1:4000',
    ...overrides,
  };
}

function gateway() {
  const config = fullConfig();
  return createAlipayGateway({
    appId: config.appId,
    privateKey: config.privateKey,
    alipayPublicKey: config.alipayPublicKey,
    apiBase: config.apiBase,
    publicBaseUrl: config.publicBaseUrl,
  });
}

/** Spec string: drop sign and sign_type, sort keys, join key=value with &. */
function unsigned(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

function rsaSign(privateKey: string, message: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(message, 'utf8');
  signer.end();
  return signer.sign(privateKey, 'base64');
}

function rsaVerify(publicKey: string, message: string, signature: string): boolean {
  return verify('RSA-SHA256', Buffer.from(message, 'utf8'), publicKey, Buffer.from(signature, 'base64'));
}

function beijing(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  const ss = String(shifted.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function notify(fields: Record<string, string>, privateKey = alipay.privateKey): string {
  const params: Record<string, string> = { ...fields, sign_type: 'RSA2' };
  params.sign = rsaSign(privateKey, unsigned(params));
  const search = new URLSearchParams();
  for (const key of Object.keys(params)) search.append(key, params[key] ?? '');
  return search.toString();
}

function paidFields(overrides: Record<string, string> = {}): Record<string, string> {
  const sample = order();
  return {
    notify_time: beijing(new Date()),
    notify_type: 'trade_status_sync',
    notify_id: 'evt_ali_paid',
    trade_status: 'TRADE_SUCCESS',
    out_trade_no: `alipay_${sample.id}`,
    trade_no: 'ali-trade-no',
    total_amount: '0.01',
    receipt_amount: '0.01',
    credits: '999999',
    ...overrides,
  };
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function startMock(handler: (req: IncomingMessage, res: ServerResponse, rawBody: string) => void) {
  const requests: Array<{ method: string; url: string; rawBody: string; host?: string }> = [];
  const server = createServer(async (req, res) => {
    const rawBody = await readRaw(req);
    requests.push({ method: req.method ?? '', url: req.url ?? '', rawBody, host: req.headers.host });
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

describe('alipay webhook signatures', () => {
  it('rejects a signature that is not RSA2 over the sorted unsigned string', async () => {
    const gw = gateway();
    const fields = paidFields();
    const params: Record<string, string> = { ...fields, sign_type: 'RSA2' };
    params.sign = rsaSign(alipay.privateKey, `${unsigned(params)}&sign_type=RSA2`);
    const search = new URLSearchParams();
    for (const key of Object.keys(params)) search.append(key, params[key] ?? '');

    await expect(gw.parseWebhook(search.toString(), {})).rejects.toMatchObject({
      statusCode: 401,
      code: 'PAYMENT_BAD_SIGNATURE',
    });
  });

  it('rejects a bad signature before the timestamp window is considered', async () => {
    const gw = gateway();
    const raw = notify(paidFields({ notify_time: beijing(new Date(Date.now() - (5 * 60 + 30) * 1000)) }), other.privateKey);

    await expect(gw.parseWebhook(raw, {})).rejects.toMatchObject({
      statusCode: 401,
      code: 'PAYMENT_BAD_SIGNATURE',
    });
  });

  it('rejects a correctly signed notification older than five minutes', async () => {
    const gw = gateway();
    const raw = notify(paidFields({ notify_time: beijing(new Date(Date.now() - (5 * 60 + 30) * 1000)) }));

    await expect(gw.parseWebhook(raw, {})).rejects.toMatchObject({
      statusCode: 401,
      code: 'PAYMENT_TIMESTAMP_EXPIRED',
    });
  });

  it('returns a paid event for TRADE_SUCCESS without carrying the callback amount or credits', async () => {
    const gw = gateway();
    const sample = order();
    const raw = notify(paidFields());

    const event = await gw.parseWebhook(raw, {});

    expect(sample.amount_cents).toBe(3900);
    expect(sample.credits).toBe(5500);
    expect(event).toEqual({
      eventId: 'evt_ali_paid',
      providerOrderId: `alipay_${sample.id}`,
      eventType: 'paid',
      txnId: 'ali-trade-no',
    });
    expect(JSON.stringify(event)).not.toContain('999999');
    expect(JSON.stringify(event)).not.toContain('0.01');
    expect(JSON.stringify(event)).not.toContain('3900');
    expect(JSON.stringify(event)).not.toContain('5500');
  });

  it('treats TRADE_FINISHED as paid and still drops callback amounts', async () => {
    const gw = gateway();
    const sample = order();
    const raw = notify(
      paidFields({
        notify_id: 'evt_ali_finished',
        trade_status: 'TRADE_FINISHED',
        total_amount: '1',
        credits: '999999',
      }),
    );

    const event = await gw.parseWebhook(raw, {});

    expect(event).toEqual({
      eventId: 'evt_ali_finished',
      providerOrderId: `alipay_${sample.id}`,
      eventType: 'paid',
      txnId: 'ali-trade-no',
    });
    expect(JSON.stringify(event)).not.toContain('999999');
  });

  it('does not invent a provider order id from the callback amount', async () => {
    const gw = gateway();
    const fields = paidFields();
    delete fields.out_trade_no;
    const raw = notify(fields);

    await expect(gw.parseWebhook(raw, {})).rejects.toMatchObject({ statusCode: 400, code: 'BAD_REQUEST' });
  });

  it('does not treat other trade statuses as paid', async () => {
    const gw = gateway();
    const raw = notify(paidFields({ trade_status: 'WAIT_BUYER_PAY', notify_id: 'evt_ali_wait' }));

    const event = await gw.parseWebhook(raw, {});

    expect(event.eventType).toBe('other');
    expect(JSON.stringify(event)).not.toContain('999999');
  });
});

describe('alipay gateway registration', () => {
  it('keeps mock as the default active gateway', () => {
    expect(env.payments.provider).toBe('mock');
    expect(env.payments.alipay.appId).toBe('');
    expect(env.payments.alipay.privateKey).toBe('');
    expect(env.payments.alipay.publicKey).toBe('');
    expect(installConfiguredAlipayGateway()).toBe(false);
    expect(activeGateway()).toMatchObject({ id: 'mock', mock: true });
    expect(findGateway('alipay')).toBeNull();
  });

  it('does not register alipay when the provider stays mock', () => {
    expect(installAlipayGateway(fullConfig({ provider: 'mock' }))).toBe(false);
    expect(findGateway('alipay')).toBeNull();
    expect(activeGateway()).toMatchObject({ id: 'mock', mock: true });
  });

  it('does not register or fall back to mock when alipay is selected but a secret is missing', () => {
    env.payments.provider = 'alipay';
    expect(installConfiguredAlipayGateway()).toBe(false);
    expect(findGateway('alipay')).toBeNull();
    expect(findGateway('mock')?.mock).toBe(true);
    expect(activeGateway()).toBeNull();

    expect(installAlipayGateway(fullConfig({ appId: '   ' }))).toBe(false);
    expect(installAlipayGateway(fullConfig({ privateKey: '' }))).toBe(false);
    expect(installAlipayGateway(fullConfig({ alipayPublicKey: '' }))).toBe(false);
    expect(findGateway('alipay')).toBeNull();
    expect(activeGateway()).toBeNull();
  });

  it('registers a non-mock gateway only when provider is alipay and required secrets are set', () => {
    expect(installAlipayGateway(fullConfig())).toBe(true);
    expect(findGateway('alipay')).toMatchObject({ id: 'alipay', mock: false });
    expect(activeGateway()).toMatchObject({ id: 'mock', mock: true });

    env.payments.provider = 'alipay';
    env.payments.alipay.appId = 'app_test_local';
    env.payments.alipay.privateKey = merchant.privateKey;
    env.payments.alipay.publicKey = alipay.publicKey;
    expect(installConfiguredAlipayGateway()).toBe(true);
    expect(activeGateway()).toMatchObject({ id: 'alipay', mock: false });
  });
});

describe('alipay precreate', () => {
  it('posts the order amount in yuan and the alipay_ merchant order id to a local gateway', async () => {
    const sample = order();
    const mock = await startMock((_req, res) => {
      const payload = JSON.stringify({
        alipay_trade_precreate_response: {
          code: '10000',
          msg: 'Success',
          qr_code: 'http://127.0.0.1/pay/alipay_test',
        },
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    });
    const gw = createAlipayGateway({
      appId: 'app_test_local',
      privateKey: merchant.privateKey,
      alipayPublicKey: alipay.publicKey,
      apiBase: mock.baseUrl,
      publicBaseUrl: 'http://127.0.0.1:4000',
    });

    const created = await gw.create(sample);

    expect(created).toEqual({
      providerOrderId: `alipay_${sample.id}`,
      payUrl: 'http://127.0.0.1/pay/alipay_test',
      expiresAt: Date.parse(sample.expires_at),
    });
    expect(mock.requests).toHaveLength(1);
    const request = mock.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/gateway.do');
    expect(request.host?.startsWith('127.0.0.1')).toBe(true);
    const params = Object.fromEntries(new URLSearchParams(request.rawBody).entries());
    const content = unsigned(params);
    const keys = content.split('&').map((part) => part.slice(0, part.indexOf('=')));
    expect(keys).toEqual([...keys].sort());
    expect(content.includes('sign_type=')).toBe(false);
    expect(rsaVerify(merchant.publicKey, content, params.sign ?? '')).toBe(true);
    expect(params.sign_type).toBe('RSA2');
    expect(params.method).toBe('alipay.trade.precreate');
    const biz = JSON.parse(params.biz_content ?? '') as { out_trade_no?: string; total_amount?: string; subject?: string };
    const yuan = `${Math.floor(sample.amount_cents / 100)}.${String(sample.amount_cents % 100).padStart(2, '0')}`;
    expect(biz.out_trade_no).toBe(`alipay_${sample.id}`);
    expect(biz.total_amount).toBe(yuan);
    expect(biz.total_amount).toBe('39.00');
    expect(request.rawBody).not.toContain(String(sample.credits));
    expect(request.rawBody).not.toContain('999999');
  });
});
