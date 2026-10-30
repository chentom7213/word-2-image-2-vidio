import 'dotenv/config';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export const env = {
  port: Number(req('PORT', '4000')),
  host: req('HOST', '127.0.0.1'),

  db: {
    host: req('DB_HOST', '127.0.0.1'),
    port: Number(req('DB_PORT', '3307')),
    user: req('DB_USER', 'benchu'),
    password: req('DB_PASSWORD', ''),
    database: req('DB_NAME', 'benchu_canvas'),
  },

  redis: {
    host: req('REDIS_HOST', '127.0.0.1'),
    port: num('REDIS_PORT', 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    stream: req('QUEUE_STREAM', 'gen:tasks'),
    group: req('QUEUE_GROUP', 'workers'),
    /** How many tasks one worker process consumes concurrently. */
    concurrency: Math.max(1, Math.floor(num('WORKER_CONCURRENCY', 1))),
    /** Disable to fall back to the in-process runner (single-node dev). */
    enabled: bool('QUEUE_ENABLED', true),
  },

  rbac: {
    /** Cache membership lookups in Redis; set to 0 to disable. */
    membershipCacheTtlSeconds: Math.max(0, Math.floor(num('RBAC_MEMBERSHIP_CACHE_TTL_SECONDS', 300))),
  },

  jwt: {
    secret: req('JWT_SECRET', 'dev-secret'),
    /** Access tokens are short-lived; the refresh cookie carries the session. */
    expiresIn: req('JWT_ACCESS_EXPIRES_IN', req('JWT_EXPIRES_IN', '15m')),
    refreshDays: num('JWT_REFRESH_DAYS', 7),
    /** Set REFRESH_COOKIE_SECURE=true behind TLS (required in production). */
    cookieSecure: bool('REFRESH_COOKIE_SECURE', false),
    cookieDomain: process.env.REFRESH_COOKIE_DOMAIN || undefined,
  },

  uploadDir: req('UPLOAD_DIR', './uploads'),
  outputDir: req('OUTPUT_DIR', './storage'),

  storage: {
    /**
     * 'local' (default) or 's3'.
     *
     * One box: local is strictly better — no network hop, no per-request cost,
     * no credentials to rotate. `s3` exists so moving off the app server (or
     * putting a CDN in front) is a config change, not a rewrite.
     */
    driver: (process.env.STORAGE_DRIVER || 'local').toLowerCase() === 's3' ? 's3' : 'local',
    /** HMAC key for signing private object URLs (local driver). */
    signSecret: req('STORAGE_SIGN_SECRET', req('JWT_SECRET', 'dev-secret')),
    /** Signed URL TTL (seconds). */
    signTtl: num('STORAGE_SIGN_TTL', 3600),
    s3: {
      endpoint: req('S3_ENDPOINT', 'http://127.0.0.1:9000'),
      region: req('S3_REGION', 'us-east-1'),
      bucket: req('S3_BUCKET', 'benchu'),
      accessKeyId: req('S3_ACCESS_KEY_ID', ''),
      secretAccessKey: req('S3_SECRET_ACCESS_KEY', ''),
      sessionToken: process.env.S3_SESSION_TOKEN || undefined,
      /** MinIO and most self-hosted gateways need path-style addressing. */
      forcePathStyle: bool('S3_FORCE_PATH_STYLE', true),
      /** Optional CDN origin; when set, signedUrl() returns a CDN URL. */
      publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || undefined,
    },
  },

  corsOrigins: req(
    'CORS_ORIGIN',
    'http://127.0.0.1:5184,http://localhost:5184,http://127.0.0.1:5183,http://localhost:5183',
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Set to protect /api/metrics; empty allows unauthenticated scrapes. */
  metricsToken: process.env.METRICS_TOKEN || undefined,

  /** Task considered dead if it stays `running` without heartbeats this long. */
  staleTaskMinutes: num('STALE_TASK_MINUTES', 10),

  payments: {
    /**
     * Active gateway. Default remains `mock`, which is refused in production
     * (see services/payments.ts). Stripe, Alipay, or WeChat Pay is registered
     * only when this names that provider and every secret it requires is
     * non-empty. Missing secrets do not fall back to mock.
     */
    provider: process.env.PAYMENT_PROVIDER || 'mock',
    /** Shared secret for the mock webhook. Stripe uses its own signing secret. */
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || '',
    /** Order lifetime in minutes before it is considered abandoned. */
    orderTtlMinutes: num('PAYMENT_ORDER_TTL_MINUTES', 30),
    /** Public base URL used to build gateway return/callback URLs. */
    publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:4000',
    stripe: {
      secretKey: (process.env.STRIPE_SECRET_KEY || '').trim(),
      webhookSecret: (process.env.STRIPE_WEBHOOK_SECRET || '').trim(),
      /**
       * Checkout API origin. Tests point this at a local server. Unset uses
       * the live Stripe API, and only after the gateway is registered.
       */
      apiBase: (process.env.STRIPE_API_BASE || 'https://api.stripe.com').trim().replace(/\/+$/, ''),
    },
    alipay: {
      appId: (process.env.ALIPAY_APP_ID || '').trim(),
      /** Merchant application private key (PEM or raw base64). */
      privateKey: (process.env.ALIPAY_PRIVATE_KEY || '').trim(),
      /** Alipay public key used to verify async notifications. */
      publicKey: (process.env.ALIPAY_PUBLIC_KEY || '').trim(),
      /**
       * OpenAPI origin. Tests point this at a local server. Unset uses the
       * live Alipay gateway, and only after this gateway is registered.
       */
      apiBase: (process.env.ALIPAY_API_BASE || 'https://openapi.alipay.com').trim().replace(/\/+$/, ''),
    },
    wechat: {
      appId: (process.env.WECHAT_APP_ID || '').trim(),
      mchId: (process.env.WECHAT_MCH_ID || '').trim(),
      /** Merchant API certificate private key (PEM or raw base64). */
      privateKey: (process.env.WECHAT_PRIVATE_KEY || '').trim(),
      serialNo: (process.env.WECHAT_SERIAL_NO || '').trim(),
      /** WeChat Pay platform public key used to verify Wechatpay-Signature. */
      platformPublicKey: (process.env.WECHAT_PLATFORM_PUBLIC_KEY || '').trim(),
      /** 32-character APIv3 key. Decrypts notification resources. */
      apiV3Key: (process.env.WECHAT_API_V3_KEY || '').trim(),
      /**
       * API origin. Tests point this at a local server. Unset uses the live
       * WeChat Pay API, and only after this gateway is registered.
       */
      apiBase: (process.env.WECHAT_API_BASE || 'https://api.mch.weixin.qq.com').trim().replace(/\/+$/, ''),
    },
  },
  oidc: {
    /** Generic OIDC for Azure AD / Okta / Keycloak / Auth0-compatible IdPs. */
    enabled: bool('OIDC_ENABLED', false),
    issuer: (process.env.OIDC_ISSUER || '').replace(/\/+$/, ''),
    clientId: process.env.OIDC_CLIENT_ID || '',
    clientSecret: process.env.OIDC_CLIENT_SECRET || '',
    redirectUri: process.env.OIDC_REDIRECT_URI || '',
    successRedirect: process.env.OIDC_SUCCESS_REDIRECT || '',
    scopes: process.env.OIDC_SCOPES || 'openid profile email',
    requireVerifiedEmail: bool('OIDC_REQUIRE_VERIFIED_EMAIL', true),
    /** Existing password accounts must be explicitly approved before linking. */
    autoLinkExisting: bool('OIDC_AUTO_LINK_EXISTING', false),
  },
  /** How often the reaper scans for zombie tasks (ms). */
  reaperIntervalMs: num('REAPER_INTERVAL_MS', 60_000),
  /** How often API/worker replicas check whether subscription credits are due. */
  monthlyCreditIntervalMs: num('MONTHLY_CREDIT_INTERVAL_MS', 60 * 60 * 1000),

  render: {
    ffmpegPath: req('FFMPEG_PATH', 'ffmpeg'),
    ffmpegThreads: Math.max(1, Math.floor(num('FFMPEG_THREADS', 2))),
    /** Internal render height cap — output is upscaled by ffmpeg to the requested size. */
    maxRenderPixels: num('RENDER_MAX_PIXELS', 640 * 640),
    fps: num('RENDER_FPS', 12),
    /** Hard ceiling so a long request cannot burn CPU indefinitely. */
    timeoutMs: num('RENDER_TIMEOUT_MS', 120_000),
  },

  moderation: {
    /** Comma-separated blocklist; matched against the prompt before charging. */
    blockedWords: req('MODERATION_BLOCKLIST', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    enabled: bool('MODERATION_ENABLED', true),
    /** Internal classifier endpoint for generated artifacts. Empty = not configured. */
    outputUrl: process.env.MODERATION_OUTPUT_URL || undefined,
    outputToken: process.env.MODERATION_OUTPUT_TOKEN || undefined,
    outputTimeoutMs: num('MODERATION_OUTPUT_TIMEOUT_MS', 8000),
  },

  seed: {
    email: req('SEED_EMAIL', 'demo@benchu.art'),
    password: req('SEED_PASSWORD', 'demo1234'),
  },

  /**
   * Generic HTTP generation API. An empty base URL does not register an
   * adapter, so single-node smoke keeps using the built-in renderer.
   */
  providers: {
    http: {
      id: req('PROVIDER_HTTP_ID', 'http'),
      baseUrl: (process.env.PROVIDER_HTTP_BASE_URL ?? '').trim().replace(/\/+$/, ''),
      apiKey: process.env.PROVIDER_HTTP_API_KEY || undefined,
      pollMs: Math.max(1, Math.floor(num('PROVIDER_HTTP_POLL_MS', 200))),
      timeoutMs: Math.max(1, Math.floor(num('PROVIDER_HTTP_TIMEOUT_MS', 120_000))),
    },
  },

  /**
   * Optional C2PA certificate and private key, PEM text. Signing is enabled
   * only when both are non-empty. Either one missing leaves files untouched.
   */
  c2pa: {
    certPem: (process.env.C2PA_CERT_PEM ?? '').trim(),
    keyPem: (process.env.C2PA_KEY_PEM ?? '').trim(),
  },
};
