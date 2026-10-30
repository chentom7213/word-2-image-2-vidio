import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createCipheriv, createSign, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/env.js';
import { activeGateway, findGateway, unregisterGateway, type OrderRow } from '../src/services/payments.js';
import {
  createWechatGateway,
  installConfiguredWechatGateway,
  installWechatGateway,
  type WechatInstallConfig,
} from '../src/services/wechat-gateway.js';

const merchant = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const platform = generateKeyPairSync('rsa', {
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
const API_V3_KEY = '0123456789abcdef0123456789abcdef';
const originalWechat = { ...env.payments.wechat };

afterEach(async () => {
  unregisterGateway('wechat');
  env.payments.provider = originalProvider;
  env.payments.wechat.appId = originalWechat.appId;
  env.payments.wechat.mchId = originalWechat.mchId;
  env.payments.wechat.privateKey = originalWechat.privateKey;
  env.payments.wechat.serialNo = originalWechat.serialNo;
  env.payments.wechat.platformPublicKey = originalWechat.platformPublicKey;
  env.payments.wechat.apiV3Key = originalWechat.apiV3Key;
  env.payments.wechat.apiBase = originalWechat.apiBase;
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
    provider: 'wechat',
    provider_order_id: null,
    provider_txn_id: null,
    idempotency_key: null,
    paid_at: null,
    expires_at: '2026-10-26T15:00:00.000Z',
    created_at: '2026-10-26T14:00:00.000Z',
    ...overrides,
  };
}

function fullConfig(overrides: Partial<WechatInstallConfig> = {}): WechatInstallConfig {
  return {
    provider: 'wechat',
    appId: 'wx_test_app',
    mchId: '1900000001',
    privateKey: merchant.privateKey,
    serialNo: 'SERIALTEST001',
    platformPublicKey: platform.publicKey,
    apiV3Key: API_V3_KEY,
    apiBase: 'http://127.0.0.1:9',
    publicBaseUrl: 'http://127.0.0.1:4000',
    ...overrides,
  };
}

function gateway() {
  const config = fullConfig();
  return createWechatGateway({
    appId: config.appId,
    mchId: config.mchId,
    privateKey: config.privateKey,
    serialNo: config.serialNo,
    platformPublicKey: config.platformPublicKey,
    apiV3Key: config.apiV3Key,
    apiBase: config.apiBase,
    publicBaseUrl: config.publicBaseUrl,
  });
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

/** API v3 webhook string: timestamp, nonce, and the exact raw body, each followed by a newline. */
function webhookMessage(timestamp: string, nonce: string, rawBody: string): string {
  return `${timestamp}\n${nonce}\n${rawBody}\n`;
}

function headers(timestamp: string, nonce: string, signature: string) {
  return {
    'Wechatpay-Timestamp': timestamp,
    'Wechatpay-Nonce': nonce,
    'Wechatpay-Signature': signature,
  };
}

function successBody(providerOrderId: string, eventType = 'TRANSACTION.SUCCESS', eventId = 'evt_wx_paid'): string {
  return JSON.stringify({
    id: eventId,
    event_type: eventType,
    amount: 1,
    credits: 999999,
    resource: {
      out_trade_no: providerOrderId,
      transaction_id: 'wx-trade-no',
      amount: { total: 1, payer_total: 1, currency: 'CNY' },
      credits: 999999,
    },
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

describe('wechat webhook signatures', () => {
  it('rejects a signature that is not SHA256-RSA over timestamp, nonce, and raw body', async () => {
    const gw = gateway();
    const sample = order();
    const raw = successBody(`wechat_${sample.id}`);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'nonce-unit';
    const wrong = rsaSign(platform.privateKey, `${timestamp}.${nonce}.${raw}`);

    await expect(gw.parseWebhook(raw, headers(timestamp, nonce, wrong))).rejects.toMatchObject({
      statusCode: 401,
      code: 'PAYMENT_BAD_SIGNATURE',
    });
  });

  it('rejects a bad signature before the timestamp window is considered', async () => {
    const gw = gateway();
    const raw = successBody(`wechat_${order().id}`);
    const timestamp = String(Math.floor(Date.now() / 1000) - 5 * 60 - 30);
    const nonce = 'nonce-old';
    const signature = rsaSign(other.privateKey, webhookMessage(timestamp, nonce, raw));

    await expect(gw.parseWebhook(raw, headers(timestamp, nonce, signature))).rejects.toMatchObject({
      statusCode: 401,
      code: 'PAYMENT_BAD_SIGNATURE',
    });
  });

  it('rejects a correctly signed event older than five minutes', async () => {
    const gw = gateway();
    const raw = successBody(`wechat_${order().id}`);
    const timestamp = String(Math.floor(Date.now() / 1000) - 5 * 60 - 30);
    const nonce = 'nonce-expired';
    const signature = rsaSign(platform.privateKey, webhookMessage(timestamp, nonce, raw));

    await expect(gw.parseWebhook(raw, headers(timestamp, nonce, signature))).rejects.toMatchObject({
      statusCode: 401,
      code: 'PAYMENT_TIMESTAMP_EXPIRED',
    });
  });

  it('returns a paid event for TRANSACTION.SUCCESS without carrying the callback amount or credits', async () => {
    const gw = gateway();
    const sample = order();
    const providerOrderId = `wechat_${sample.id}`;
    const raw = successBody(providerOrderId);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'nonce-paid';
    const signature = rsaSign(platform.privateKey, webhookMessage(timestamp, nonce, raw));

    const event = await gw.parseWebhook(raw, headers(timestamp, nonce, signature));

    expect(sample.amount_cents).toBe(3900);
    expect(sample.credits).toBe(5500);
    expect(event).toEqual({
      eventId: 'evt_wx_paid',
      providerOrderId,
      eventType: 'paid',
      txnId: 'wx-trade-no',
    });
    expect(JSON.stringify(event)).not.toContain('999999');
    expect(JSON.stringify(event)).not.toContain('"amount"');
    expect(JSON.stringify(event)).not.toContain('3900');
    expect(JSON.stringify(event)).not.toContain('5500');
  });

  it('does not treat other event types as paid', async () => {
    const gw = gateway();
    const raw = successBody(`wechat_${order().id}`, 'REFUND.SUCCESS', 'evt_wx_refund');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'nonce-other';
    const signature = rsaSign(platform.privateKey, webhookMessage(timestamp, nonce, raw));

    const event = await gw.parseWebhook(raw, headers(timestamp, nonce, signature));

    expect(event.eventType).toBe('other');
    expect(JSON.stringify(event)).not.toContain('999999');
  });

  it('does not invent a provider order id from the callback amount', async () => {
    const gw = gateway();
    const raw = JSON.stringify({
      id: 'evt_wx_no_order',
      event_type: 'TRANSACTION.SUCCESS',
      amount: { total: 3900 },
      credits: 5500,
      resource: { amount: { total: 1 }, credits: 999999 },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'nonce-missing';
    const signature = rsaSign(platform.privateKey, webhookMessage(timestamp, nonce, raw));

    await expect(gw.parseWebhook(raw, headers(timestamp, nonce, signature))).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
  });

  it('reads out_trade_no from the decrypted APIv3 resource and ignores its amount', async () => {
    const gw = gateway();
    const providerOrderId = `wechat_${order().id}`;
    const nonce = '0123456789ab';
    const associated = 'transaction';
    const plaintext = JSON.stringify({
      out_trade_no: providerOrderId,
      transaction_id: 'wx-trade-encrypted',
      amount: { total: 1, payer_total: 1 },
      credits: 999999,
    });
    const iv = Buffer.from(nonce, 'utf8');
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(API_V3_KEY, 'utf8'), iv);
    cipher.setAAD(Buffer.from(associated, 'utf8'));
    const packed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    const raw = JSON.stringify({
      id: 'evt_wx_encrypted',
      event_type: 'TRANSACTION.SUCCESS',
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext: packed.toString('base64'),
        associated_data: associated,
        nonce,
        amount: { total: 1 },
        credits: 999999,
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = rsaSign(platform.privateKey, webhookMessage(timestamp, 'nonce-encrypted', raw));

    const event = await gw.parseWebhook(raw, headers(timestamp, 'nonce-encrypted', signature));

    expect(event).toEqual({
      eventId: 'evt_wx_encrypted',
      providerOrderId,
      eventType: 'paid',
      txnId: 'wx-trade-encrypted',
    });
    expect(JSON.stringify(event)).not.toContain('999999');
    expect(JSON.stringify(event)).not.toContain('3900');
  });

  it('rejects a signed notification whose resource cannot be decrypted', async () => {
    const gw = gateway();
    const raw = JSON.stringify({
      id: 'evt_wx_bad_cipher',
      event_type: 'TRANSACTION.SUCCESS',
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext: Buffer.from(randomBytes(32)).toString('base64'),
        associated_data: 'transaction',
        nonce: '0123456789ab',
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = rsaSign(platform.privateKey, webhookMessage(timestamp, 'nonce-bad-cipher', raw));

    await expect(gw.parseWebhook(raw, headers(timestamp, 'nonce-bad-cipher', signature))).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
  });
});

describe('wechat gateway registration', () => {
  it('keeps mock as the default active gateway', () => {
    expect(env.payments.provider).toBe('mock');
    expect(env.payments.wechat.appId).toBe('');
    expect(env.payments.wechat.mchId).toBe('');
    expect(env.payments.wechat.privateKey).toBe('');
    expect(env.payments.wechat.serialNo).toBe('');
    expect(env.payments.wechat.platformPublicKey).toBe('');
    expect(env.payments.wechat.apiV3Key).toBe('');
    expect(installConfiguredWechatGateway()).toBe(false);
    expect(activeGateway()).toMatchObject({ id: 'mock', mock: true });
    expect(findGateway('wechat')).toBeNull();
  });

  it('does not register wechat when the provider stays mock', () => {
    expect(installWechatGateway(fullConfig({ provider: 'mock' }))).toBe(false);
    expect(findGateway('wechat')).toBeNull();
    expect(activeGateway()).toMatchObject({ id: 'mock', mock: true });
  });

  it('does not register or fall back to mock when wechat is selected but a secret is missing', () => {
    env.payments.provider = 'wechat';
    expect(installConfiguredWechatGateway()).toBe(false);
    expect(findGateway('wechat')).toBeNull();
    expect(findGateway('mock')?.mock).toBe(true);
    expect(activeGateway()).toBeNull();

    expect(installWechatGateway(fullConfig({ appId: ' ' }))).toBe(false);
    expect(installWechatGateway(fullConfig({ mchId: '' }))).toBe(false);
    expect(installWechatGateway(fullConfig({ privateKey: '' }))).toBe(false);
    expect(installWechatGateway(fullConfig({ serialNo: '' }))).toBe(false);
    expect(installWechatGateway(fullConfig({ platformPublicKey: '' }))).toBe(false);
    expect(installWechatGateway(fullConfig({ apiV3Key: '' }))).toBe(false);
    expect(installWechatGateway(fullConfig({ apiV3Key: 'short' }))).toBe(false);
    expect(findGateway('wechat')).toBeNull();
    expect(activeGateway()).toBeNull();
  });

  it('registers a non-mock gateway only when provider is wechat and required secrets are set', () => {
    expect(installWechatGateway(fullConfig())).toBe(true);
    expect(findGateway('wechat')).toMatchObject({ id: 'wechat', mock: false });
    expect(activeGateway()).toMatchObject({ id: 'mock', mock: true });

    env.payments.provider = 'wechat';
    env.payments.wechat.appId = 'wx_test_app';
    env.payments.wechat.mchId = '1900000001';
    env.payments.wechat.privateKey = merchant.privateKey;
    env.payments.wechat.serialNo = 'SERIALTEST001';
    env.payments.wechat.platformPublicKey = platform.publicKey;
    env.payments.wechat.apiV3Key = API_V3_KEY;
    expect(installConfiguredWechatGateway()).toBe(true);
    expect(activeGateway()).toMatchObject({ id: 'wechat', mock: false });
  });
});

describe('wechat native order', () => {
  it('posts order.amount_cents and the wechat_ merchant order id to a local API', async () => {
    const sample = order();
    const mock = await startMock((_req, res) => {
      const payload = JSON.stringify({ code_url: 'http://127.0.0.1/pay/wechat_test' });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    });
    const gw = createWechatGateway({
      appId: 'wx_test_app',
      mchId: '1900000001',
      privateKey: merchant.privateKey,
      serialNo: 'SERIALTEST001',
      platformPublicKey: platform.publicKey,
      apiV3Key: API_V3_KEY,
      apiBase: mock.baseUrl,
      publicBaseUrl: 'http://127.0.0.1:4000',
    });

    const created = await gw.create(sample);

    expect(created).toEqual({
      providerOrderId: `wechat_${sample.id}`,
      payUrl: 'http://127.0.0.1/pay/wechat_test',
      expiresAt: Date.parse(sample.expires_at),
    });
    expect(mock.requests).toHaveLength(1);
    const request = mock.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v3/pay/transactions/native');
    expect(request.host?.startsWith('127.0.0.1')).toBe(true);
    const payload = JSON.parse(request.rawBody) as {
      appid?: string;
      mchid?: string;
      out_trade_no?: string;
      notify_url?: string;
      amount?: { total?: number; currency?: string };
      credits?: unknown;
    };
    expect(payload.out_trade_no).toBe(`wechat_${sample.id}`);
    expect(payload.amount).toEqual({ total: sample.amount_cents, currency: 'CNY' });
    expect(payload.credits).toBeUndefined();
    expect(request.rawBody).not.toContain(String(sample.credits));
    expect(request.rawBody).not.toContain('999999');
    const authorization = request.authorization ?? '';
    const fields = Object.fromEntries([...authorization.matchAll(/([A-Za-z0-9_]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
    expect(authorization.startsWith('WECHATPAY2-SHA256-RSA2048 ')).toBe(true);
    expect(fields.mchid).toBe('1900000001');
    expect(fields.serial_no).toBe('SERIALTEST001');
    const message = `POST\n/v3/pay/transactions/native\n${fields.timestamp}\n${fields.nonce_str}\n${request.rawBody}\n`;
    expect(rsaVerify(merchant.publicKey, message, fields.signature ?? '')).toBe(true);
  });
});
