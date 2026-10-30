import { createDecipheriv, createHash, createSign, constants, publicDecrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { toMillis } from '../lib/dto.js';
import { ApiError } from '../lib/errors.js';
import { registerGateway, type Gateway, type WebhookEvent } from './payments.js';

const WECHAT_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const DEFAULT_API_BASE = 'https://api.mch.weixin.qq.com';
const NATIVE_PATH = '/v3/pay/transactions/native';
const SHA256_DIGESTINFO_PREFIX = Buffer.from('3031300d060960864801650304020105000420', 'hex');

export type WechatGatewayOptions = {
  appId: string;
  mchId: string;
  /** Merchant API private key. Signs the native-order request. */
  privateKey: string;
  serialNo: string;
  /** WeChat Pay platform public key. Verifies Wechatpay-Signature. */
  platformPublicKey: string;
  /** 32-character APIv3 key. Decrypts the notification resource. */
  apiV3Key: string;
  /** API origin. Tests point this at a local server. */
  apiBase?: string;
  publicBaseUrl: string;
};

export type WechatInstallConfig = {
  provider: string;
  appId: string;
  mchId: string;
  privateKey: string;
  serialNo: string;
  platformPublicKey: string;
  apiV3Key: string;
  apiBase?: string;
  publicBaseUrl: string;
};

/**
 * Registers WeChat Pay only for an explicit wechat provider with every required
 * secret. A missing secret leaves the registry unchanged and does not select mock.
 */
export function installWechatGateway(config: WechatInstallConfig): boolean {
  if (config.provider !== 'wechat') return false;
  const appId = config.appId.trim();
  const mchId = config.mchId.trim();
  const privateKey = config.privateKey.trim();
  const serialNo = config.serialNo.trim();
  const platformPublicKey = config.platformPublicKey.trim();
  const apiV3Key = config.apiV3Key.trim();
  if (!appId || !mchId || !privateKey || !serialNo || !platformPublicKey || !isApiV3Key(apiV3Key)) return false;
  registerGateway(
    createWechatGateway({
      appId,
      mchId,
      privateKey,
      serialNo,
      platformPublicKey,
      apiV3Key,
      apiBase: config.apiBase,
      publicBaseUrl: config.publicBaseUrl,
    }),
  );
  return true;
}

/** Startup hook. Reads env and no-ops unless WeChat Pay is fully configured. */
export function installConfiguredWechatGateway(): boolean {
  return installWechatGateway({
    provider: env.payments.provider,
    appId: env.payments.wechat.appId,
    mchId: env.payments.wechat.mchId,
    privateKey: env.payments.wechat.privateKey,
    serialNo: env.payments.wechat.serialNo,
    platformPublicKey: env.payments.wechat.platformPublicKey,
    apiV3Key: env.payments.wechat.apiV3Key,
    apiBase: env.payments.wechat.apiBase,
    publicBaseUrl: env.payments.publicBaseUrl,
  });
}

export function createWechatGateway(options: WechatGatewayOptions): Gateway {
  const appId = options.appId.trim();
  const mchId = options.mchId.trim();
  const privateKey = options.privateKey.trim();
  const serialNo = options.serialNo.trim();
  const platformPublicKey = options.platformPublicKey.trim();
  const apiV3Key = options.apiV3Key.trim();
  const apiBase = (options.apiBase || DEFAULT_API_BASE).trim().replace(/\/+$/, '') || DEFAULT_API_BASE;
  const publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '');

  return {
    id: 'wechat',
    mock: false,
    async create(order) {
      // amount.total is fen, the same integer as the order row. Credits and any
      // client-supplied amount are not sent.
      const providerOrderId = `wechat_${order.id}`;
      const amountCents = orderAmountCents(order.amount_cents);
      const body = JSON.stringify({
        appid: appId,
        mchid: mchId,
        description: order.sku_name,
        out_trade_no: providerOrderId,
        notify_url: `${publicBaseUrl}/api/billing/webhook/wechat`,
        amount: { total: amountCents, currency: 'CNY' },
      });
      const { href, signedPath } = resolveEndpoint(apiBase, NATIVE_PATH);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = randomBytes(16).toString('hex');
      const signature = signSha256WithRsa(privateKey, wechatRequestMessage('POST', signedPath, timestamp, nonce, body));
      const authorization =
        `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",` +
        `signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`;

      let response: Response;
      try {
        response = await fetch(href, {
          method: 'POST',
          headers: {
            Authorization: authorization,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : '微信支付下单请求失败';
        throw new ApiError(502, message, 'PAYMENT_PROVIDER_ERROR');
      }

      if (!response.ok) {
        throw new ApiError(502, '微信支付下单失败', 'PAYMENT_PROVIDER_ERROR');
      }

      let payload: { code_url?: unknown };
      try {
        payload = (await response.json()) as { code_url?: unknown };
      } catch {
        throw new ApiError(502, '微信支付返回了无法解析的响应', 'PAYMENT_PROVIDER_ERROR');
      }
      if (typeof payload.code_url !== 'string' || !payload.code_url) {
        throw new ApiError(502, '微信支付未返回支付链接', 'PAYMENT_PROVIDER_ERROR');
      }

      return {
        providerOrderId,
        payUrl: payload.code_url,
        expiresAt: toMillis(order.expires_at),
      };
    },

    async parseWebhook(rawBody, headers): Promise<WebhookEvent> {
      if (!platformPublicKey) {
        throw new ApiError(503, 'WECHAT_PLATFORM_PUBLIC_KEY is not configured', 'PAYMENT_NOT_CONFIGURED');
      }
      const timestamp = headerValue(headers, 'wechatpay-timestamp');
      const nonce = headerValue(headers, 'wechatpay-nonce');
      const signature = headerValue(headers, 'wechatpay-signature');
      if (!timestamp || !nonce || !signature) {
        throw new ApiError(401, 'Webhook signature verification failed', 'PAYMENT_BAD_SIGNATURE');
      }
      // Signature first. An expired Wechatpay-Timestamp must not mask a bad MAC.
      const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
      if (!verifySha256WithRsa(platformPublicKey, message, signature)) {
        throw new ApiError(401, 'Webhook signature verification failed', 'PAYMENT_BAD_SIGNATURE');
      }
      assertTimestampFresh(timestamp);
      return normalizeEvent(rawBody, apiV3Key);
    },
  };
}

/** API v3 request string. The webhook string is `${timestamp}\n${nonce}\n${rawBody}\n`. */
function wechatRequestMessage(method: string, signedPath: string, timestamp: string, nonce: string, body: string): string {
  return `${method}\n${signedPath}\n${timestamp}\n${nonce}\n${body}\n`;
}

function orderAmountCents(amountCents: number): number {
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) {
    throw new ApiError(502, '订单金额无效', 'PAYMENT_PROVIDER_ERROR');
  }
  return amountCents;
}

function resolveEndpoint(apiBase: string, path: string): { href: string; signedPath: string } {
  let base: URL;
  try {
    base = new URL(apiBase);
  } catch {
    throw new ApiError(502, '微信支付网关地址无效', 'PAYMENT_PROVIDER_ERROR');
  }
  const prefix = base.pathname.replace(/\/+$/, '');
  const signedPath = `${prefix}${path}`;
  return { href: new URL(signedPath, base.origin).href, signedPath };
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

/**
 * TRANSACTION.SUCCESS is paid. amount, payer_total, and credits are ignored:
 * crediting reads the order row later. providerOrderId is the merchant
 * out_trade_no minted at create (`wechat_${order.id}`), never an amount.
 */
function isApiV3Key(value: string): boolean {
  return value.length === 32;
}

/**
 * Production notifications put the transaction in `resource.ciphertext`
 * (AEAD_AES_256_GCM). The last 16 decoded bytes are the auth tag. Amount and
 * credits inside the plaintext are ignored.
 */
function decryptResource(apiV3Key: string, resource: Record<string, unknown>): Record<string, unknown> {
  if (!isApiV3Key(apiV3Key)) {
    throw new ApiError(503, 'WECHAT_API_V3_KEY is not configured', 'PAYMENT_NOT_CONFIGURED');
  }
  const algorithm = typeof resource.algorithm === 'string' ? resource.algorithm : 'AEAD_AES_256_GCM';
  if (algorithm !== 'AEAD_AES_256_GCM') {
    throw new ApiError(400, '微信支付通知无法解密', 'BAD_REQUEST');
  }
  const ciphertext = typeof resource.ciphertext === 'string' ? resource.ciphertext.trim() : '';
  const nonce = typeof resource.nonce === 'string' ? resource.nonce : '';
  const associated = typeof resource.associated_data === 'string' ? resource.associated_data : '';
  if (!ciphertext || !nonce) throw new ApiError(400, '微信支付通知无法解密', 'BAD_REQUEST');
  const packed = Buffer.from(ciphertext, 'base64');
  if (packed.length <= 16) throw new ApiError(400, '微信支付通知无法解密', 'BAD_REQUEST');
  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(nonce, 'utf8'));
    decipher.setAuthTag(packed.subarray(packed.length - 16));
    if (associated) decipher.setAAD(Buffer.from(associated, 'utf8'));
    const plain = Buffer.concat([
      decipher.update(packed.subarray(0, packed.length - 16)),
      decipher.final(),
    ]);
    const parsed = asRecord(JSON.parse(plain.toString('utf8')));
    if (!parsed) throw new Error('微信支付通知明文不是对象');
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, '微信支付通知无法解密', 'BAD_REQUEST');
  }
}

function normalizeEvent(rawBody: string, apiV3Key: string): WebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ApiError(400, 'Webhook payload is missing required fields', 'BAD_REQUEST');
  }
  const event = asRecord(parsed);
  if (!event) throw new ApiError(400, 'Webhook payload is missing required fields', 'BAD_REQUEST');

  const eventId = typeof event.id === 'string' ? event.id.trim() : '';
  const eventType = event.event_type === 'TRANSACTION.SUCCESS' ? 'paid' : 'other';
  const resource = asRecord(event.resource);
  const transaction = resource && typeof resource.ciphertext === 'string' && resource.ciphertext.trim()
    ? decryptResource(apiV3Key, resource)
    : resource;
  const providerOrderId = firstString(event.out_trade_no, transaction?.out_trade_no);
  const txnId = firstString(event.transaction_id, transaction?.transaction_id);

  if (!eventId || (eventType === 'paid' && !providerOrderId)) {
    throw new ApiError(400, 'Webhook payload is missing required fields', 'BAD_REQUEST');
  }

  return {
    eventId,
    providerOrderId: providerOrderId || `wechat_unmatched_${eventId}`,
    eventType,
    txnId: txnId || null,
  };
}

function assertTimestampFresh(timestampRaw: string): void {
  if (!/^\d+$/.test(timestampRaw)) {
    throw new ApiError(401, 'Webhook timestamp is outside the 5 minute tolerance', 'PAYMENT_TIMESTAMP_EXPIRED');
  }
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestampRaw));
  if (age > WECHAT_SIGNATURE_TOLERANCE_SECONDS) {
    throw new ApiError(401, 'Webhook timestamp is outside the 5 minute tolerance', 'PAYMENT_TIMESTAMP_EXPIRED');
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function signSha256WithRsa(privateKeyPem: string, message: string): string {
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(message, 'utf8');
    signer.end();
    return signer.sign(normalizePrivateKey(privateKeyPem), 'base64');
  } catch {
    throw new ApiError(502, '微信支付请求签名失败', 'PAYMENT_PROVIDER_ERROR');
  }
}

/**
 * SHA256-RSA over the webhook string. The platform public key recovers
 * DigestInfo; timingSafeEqual compares it with the SHA-256 DigestInfo.
 * A bad signature is rejected here, before the 5-minute window.
 */
function verifySha256WithRsa(publicKeyPem: string, message: string, signatureB64: string): boolean {
  const digestInfo = Buffer.concat([
    SHA256_DIGESTINFO_PREFIX,
    createHash('sha256').update(message, 'utf8').digest(),
  ]);
  let recovered: Buffer | null = null;
  try {
    const signature = decodeSignature(signatureB64);
    if (signature) {
      recovered = publicDecrypt(
        { key: normalizePublicKey(publicKeyPem), padding: constants.RSA_PKCS1_PADDING },
        signature,
      );
    }
  } catch {
    recovered = null;
  }
  const actual = recovered && recovered.length === digestInfo.length ? recovered : Buffer.alloc(digestInfo.length);
  const matches = timingSafeEqual(actual, digestInfo);
  return recovered !== null && recovered.length === digestInfo.length && matches;
}

function decodeSignature(signatureB64: string): Buffer | null {
  const compact = signatureB64.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!compact) return null;
  const signature = Buffer.from(compact, 'base64');
  return signature.length > 0 ? signature : null;
}

function normalizePrivateKey(raw: string): string {
  return normalizePem(raw, 'PRIVATE KEY');
}

function normalizePublicKey(raw: string): string {
  return normalizePem(raw, 'PUBLIC KEY');
}

function normalizePem(raw: string, label: 'PRIVATE KEY' | 'PUBLIC KEY'): string {
  const unescaped = raw.trim().replace(/\\n/g, '\n');
  if (unescaped.includes('BEGIN')) return unescaped;
  const body = unescaped.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}
