import { createHash, createSign, constants, publicDecrypt, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { toMillis } from '../lib/dto.js';
import { ApiError } from '../lib/errors.js';
import { registerGateway, type Gateway, type WebhookEvent } from './payments.js';

const ALIPAY_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const DEFAULT_API_BASE = 'https://openapi.alipay.com';
const SHA256_DIGESTINFO_PREFIX = Buffer.from('3031300d060960864801650304020105000420', 'hex');

export type AlipayGatewayOptions = {
  appId: string;
  /** Merchant private key. Signs the precreate request. */
  privateKey: string;
  /** Alipay public key. Verifies async notifications. */
  alipayPublicKey: string;
  /** OpenAPI origin. Tests point this at a local server. */
  apiBase?: string;
  publicBaseUrl: string;
};

export type AlipayInstallConfig = {
  provider: string;
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  apiBase?: string;
  publicBaseUrl: string;
};

/**
 * Registers Alipay only for an explicit alipay provider with every required
 * secret. A missing secret leaves the registry unchanged and does not select mock.
 */
export function installAlipayGateway(config: AlipayInstallConfig): boolean {
  if (config.provider !== 'alipay') return false;
  const appId = config.appId.trim();
  const privateKey = config.privateKey.trim();
  const alipayPublicKey = config.alipayPublicKey.trim();
  if (!appId || !privateKey || !alipayPublicKey) return false;
  registerGateway(
    createAlipayGateway({
      appId,
      privateKey,
      alipayPublicKey,
      apiBase: config.apiBase,
      publicBaseUrl: config.publicBaseUrl,
    }),
  );
  return true;
}

/** Startup hook. Reads env and no-ops unless Alipay is fully configured. */
export function installConfiguredAlipayGateway(): boolean {
  return installAlipayGateway({
    provider: env.payments.provider,
    appId: env.payments.alipay.appId,
    privateKey: env.payments.alipay.privateKey,
    alipayPublicKey: env.payments.alipay.publicKey,
    apiBase: env.payments.alipay.apiBase,
    publicBaseUrl: env.payments.publicBaseUrl,
  });
}

export function createAlipayGateway(options: AlipayGatewayOptions): Gateway {
  const appId = options.appId.trim();
  const privateKey = options.privateKey.trim();
  const alipayPublicKey = options.alipayPublicKey.trim();
  const apiBase = (options.apiBase || DEFAULT_API_BASE).trim().replace(/\/+$/, '') || DEFAULT_API_BASE;
  const publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '');

  return {
    id: 'alipay',
    mock: false,
    async create(order) {
      // Price comes from the order row. total_amount is Alipay's yuan string,
      // derived only from order.amount_cents. The webhook cannot substitute it.
      const providerOrderId = `alipay_${order.id}`;
      const bizContent = JSON.stringify({
        out_trade_no: providerOrderId,
        total_amount: centsToYuan(order.amount_cents),
        subject: order.sku_name,
        product_code: 'FACE_TO_FACE_PAYMENT',
      });
      const params: Record<string, string> = {
        app_id: appId,
        method: 'alipay.trade.precreate',
        format: 'JSON',
        charset: 'utf-8',
        sign_type: 'RSA2',
        timestamp: formatBeijingTimestamp(),
        version: '1.0',
        notify_url: `${publicBaseUrl}/api/billing/webhook/alipay`,
        biz_content: bizContent,
      };
      params.sign = signSha256WithRsa(privateKey, alipaySignContent(params));
      const { href } = resolveEndpoint(apiBase, '/gateway.do');

      let response: Response;
      try {
        response = await fetch(href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
          body: formBody(params),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : '支付宝下单请求失败';
        throw new ApiError(502, message, 'PAYMENT_PROVIDER_ERROR');
      }

      if (!response.ok) {
        throw new ApiError(502, '支付宝下单失败', 'PAYMENT_PROVIDER_ERROR');
      }

      let payload: {
        alipay_trade_precreate_response?: { code?: unknown; qr_code?: unknown };
      };
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        throw new ApiError(502, '支付宝返回了无法解析的响应', 'PAYMENT_PROVIDER_ERROR');
      }
      const result = payload.alipay_trade_precreate_response;
      if (!result || (result.code !== '10000' && result.code !== 10000)) {
        throw new ApiError(502, '支付宝下单失败', 'PAYMENT_PROVIDER_ERROR');
      }
      if (typeof result.qr_code !== 'string' || !result.qr_code) {
        throw new ApiError(502, '支付宝未返回支付链接', 'PAYMENT_PROVIDER_ERROR');
      }

      return {
        providerOrderId,
        payUrl: result.qr_code,
        expiresAt: toMillis(order.expires_at),
      };
    },

    async parseWebhook(rawBody, _headers): Promise<WebhookEvent> {
      if (!alipayPublicKey) {
        throw new ApiError(503, 'ALIPAY_PUBLIC_KEY is not configured', 'PAYMENT_NOT_CONFIGURED');
      }
      const params = parseNotifyParams(rawBody);
      const signature = params.sign ?? '';
      // Signature first. An old or missing notify_time must not mask a bad MAC.
      if (!signature || !verifySha256WithRsa(alipayPublicKey, alipaySignContent(params), signature)) {
        throw new ApiError(401, 'Webhook signature verification failed', 'PAYMENT_BAD_SIGNATURE');
      }
      assertNotifyFresh(params.notify_time || params.timestamp || '');
      return normalizeEvent(params);
    },
  };
}

/**
 * RSA2 content: drop `sign` and `sign_type`, sort the remaining keys, and join
 * `key=value` with `&`. Values are the decoded originals, not URL-encoded.
 */
function alipaySignContent(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

/** Alipay total_amount is yuan with two decimals. The only input is the order row. */
function centsToYuan(amountCents: number): string {
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) {
    throw new ApiError(502, '订单金额无效', 'PAYMENT_PROVIDER_ERROR');
  }
  const yuan = Math.floor(amountCents / 100);
  const frac = String(amountCents % 100).padStart(2, '0');
  return `${yuan}.${frac}`;
}

function formatBeijingTimestamp(date = new Date()): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  const ss = String(shifted.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function formBody(fields: Record<string, string>): string {
  return Object.keys(fields)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(fields[key] ?? '')}`)
    .join('&');
}

function resolveEndpoint(apiBase: string, path: string): { href: string; signedPath: string } {
  let base: URL;
  try {
    base = new URL(apiBase);
  } catch {
    throw new ApiError(502, '支付宝网关地址无效', 'PAYMENT_PROVIDER_ERROR');
  }
  const prefix = base.pathname.replace(/\/+$/, '');
  const signedPath = `${prefix}${path}`;
  return { href: new URL(signedPath, base.origin).href, signedPath };
}

function parseNotifyParams(rawBody: string): Record<string, string> {
  const trimmed = rawBody.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return flattenNotify(parsed);
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(rawBody).entries()) out[key] = value;
  return out;
}

function flattenNotify(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      out[key] = String(item);
    }
  }
  return out;
}

/**
 * TRADE_SUCCESS and TRADE_FINISHED are paid. total_amount, receipt_amount,
 * and credits are ignored: crediting reads the order row later.
 */
function normalizeEvent(params: Record<string, string>): WebhookEvent {
  const eventId = (params.notify_id ?? '').trim();
  const tradeStatus = (params.trade_status ?? '').trim();
  const eventType = tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED' ? 'paid' : 'other';
  const providerOrderId = (params.out_trade_no ?? '').trim();
  const txnId = (params.trade_no ?? '').trim();

  if (!eventId || (eventType === 'paid' && !providerOrderId)) {
    throw new ApiError(400, 'Webhook payload is missing required fields', 'BAD_REQUEST');
  }

  return {
    eventId,
    providerOrderId: providerOrderId || `alipay_unmatched_${eventId}`,
    eventType,
    txnId: txnId || null,
  };
}

function assertNotifyFresh(raw: string): void {
  const timestamp = parseNotifyTime(raw);
  if (timestamp === null) {
    throw new ApiError(401, 'Webhook timestamp is outside the 5 minute tolerance', 'PAYMENT_TIMESTAMP_EXPIRED');
  }
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > ALIPAY_SIGNATURE_TOLERANCE_SECONDS) {
    throw new ApiError(401, 'Webhook timestamp is outside the 5 minute tolerance', 'PAYMENT_TIMESTAMP_EXPIRED');
  }
}

function parseNotifyTime(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{13}$/.test(trimmed)) return Math.floor(Number(trimmed) / 1000);
  if (/^\d{10}$/.test(trimmed)) return Number(trimmed);
  const beijing = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (beijing) {
    const iso = `${beijing[1]}-${beijing[2]}-${beijing[3]}T${beijing[4]}:${beijing[5]}:${beijing[6]}+08:00`;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function signSha256WithRsa(privateKeyPem: string, message: string): string {
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(message, 'utf8');
    signer.end();
    return signer.sign(normalizePrivateKey(privateKeyPem), 'base64');
  } catch {
    throw new ApiError(502, '支付宝请求签名失败', 'PAYMENT_PROVIDER_ERROR');
  }
}

/**
 * SHA256withRSA. The public key recovers DigestInfo; timingSafeEqual compares
 * it with the SHA-256 DigestInfo of the unsigned string. A bad signature is
 * rejected here, before the timestamp window.
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
