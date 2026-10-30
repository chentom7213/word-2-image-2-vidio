import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { accessLogFields } from './lib/access-log.js';
import { redactUrl } from './lib/redact-url.js';
import { transportHeaders } from './lib/transport-headers.js';
import { env } from './env.js';
import { pool } from './db/pool.js';
import { ApiError } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { generationRoutes } from './routes/generations.js';
import { assetRoutes, uploadRoot } from './routes/assets.js';
import { creditRoutes } from './routes/credits.js';
import { modelRoutes } from './routes/models.js';
import { mediaRoutes } from './routes/media.js';
import { tenantRoutes } from './routes/tenants.js';
import { apiKeyRoutes } from './routes/apiKeys.js';
import { adminRoutes } from './routes/admin.js';
import { billingRoutes } from './routes/billing.js';
import { canvasRoutes } from './routes/canvas.js';
import { recoverOrphanTasks, reconcileIssueCount, staleRunningCount } from './services/pipeline.js';
import { incCounter, observeHistogram, renderPrometheus } from './lib/metrics.js';
import { queueDepth } from './services/queue.js';
import { QueueRunner, startReaper } from './services/runner.js';
import { enqueue, redisAvailable, closeRedis } from './services/queue.js';
import { storageRoot } from './services/storage.js';
import { outputModerationActive, reportModerationStatus } from './services/moderation.js';
import { startMonthlyCreditScheduler } from './services/monthlyCredits.js';
import { stopTelemetry } from './telemetry.js';
import { trustSingleProxyHop } from './lib/proxy.js';
import { installConfiguredProviders } from './services/http-provider.js';
import { installConfiguredStripeGateway } from './services/stripe-gateway.js';
import { installConfiguredAlipayGateway } from './services/alipay-gateway.js';
import { installConfiguredWechatGateway } from './services/wechat-gateway.js';

/**
 * JSON logs in production (Loki/Datadog friendly), pretty in dev.
 * Every line carries `traceId` (the request id) so a request can be followed
 * across API → queue → worker.
 */
const app = Fastify({
  // The single-machine topology has exactly one trusted nginx hop. This keeps
  // IP audit/rate-limit keys per client without trusting arbitrary spoofed hops.
  trustProxy: trustSingleProxyHop,
  genReqId: (req) => (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) || randomUUID(),
  logger:
    process.env.NODE_ENV === 'production' || process.env.LOG_JSON === 'true'
      ? { level: process.env.LOG_LEVEL ?? 'info' }
      : {
          level: process.env.LOG_LEVEL ?? 'info',
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:mm:ss', ignore: 'pid,hostname' },
          },
        },
  // We emit our own single structured access line in `onResponse` (one log
  // line per request, carrying traceId/status/ms), so Fastify's built-in
  // "incoming request" + "request completed" pair would just be noise plus a
  // duplicate of the same data. `requestIdLogLabel: 'traceId'` makes the
  // request-scoped binding use the same key our own log lines use, so a log
  // search on `traceId` finds everything for one request.
  logController: new LogController({
    disableRequestLogging: true,
    requestIdLogLabel: 'traceId',
  }),
});

// Embedded runner: in a single-process deployment the API also consumes the
// queue. Set EMBEDDED_WORKER=false when running `npm run worker` separately.
const EMBEDDED_WORKER = process.env.EMBEDDED_WORKER !== 'false';

let runner: QueueRunner | null = null;
let reaper: NodeJS.Timeout | null = null;
let monthlyCreditScheduler: NodeJS.Timeout | null = null;


async function build() {
  await app.register(cors, { origin: env.corsOrigins, credentials: true });
  await app.register(cookie, { secret: env.jwt.secret });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  await app.register(fastifyStatic, { root: uploadRoot, prefix: '/uploads/' });

  /**
   * Error + 404 handlers MUST be installed before any route plugin is
   * registered: Fastify copies the handler into each encapsulated child
   * context at registration time, so a later `setErrorHandler` is invisible
   * to already-registered routes, which then silently fall back to the
   * default `{statusCode, error, message}` body and break the client contract.
   */
  app.setErrorHandler((err: any, req, reply) => {
    const traceId = String(req.id);

    if (err instanceof ApiError) {
      if (err.statusCode >= 500) req.log.error({ err, traceId }, 'api error');
      else req.log.info({ code: err.code, statusCode: err.statusCode, traceId }, 'request rejected');
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, traceId });
    }

    // Zod / Fastify validation bubbles up with an `issues` array.
    if (Array.isArray(err?.issues)) {
      return reply.code(400).send({
        error: 'BAD_REQUEST',
        message: err.issues[0]?.message ?? '参数错误',
        traceId,
      });
    }

    const status = Number(err?.statusCode) >= 400 ? Number(err.statusCode) : 500;
    if (status >= 500) {
      req.log.error({ err, traceId }, 'unhandled error');
      return reply.code(500).send({ error: 'INTERNAL', message: '服务器内部错误', traceId });
    }
    // Framework-level 4xx (payload too large, unsupported content type, …)
    return reply.code(status).send({
      error: err?.code ? String(err.code).toUpperCase().replace(/\W+/g, '_') : 'BAD_REQUEST',
      message: err?.message ?? '请求错误',
      traceId,
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: 'NOT_FOUND',
      message: `路由不存在: ${req.method} ${req.url.split('?')[0]}`,
      traceId: String(req.id),
    }),
  );

  // Metrics + structured access log. The request counter carries status so
  // alert rules can compute a 5xx ratio.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Request-Id', String(req.id));
    for (const [name, value] of Object.entries(transportHeaders(req.protocol))) reply.header(name, value);
    incCounter('benchu_http_started_total', 'HTTP requests started', 1);
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unknown';
    const ms = reply.elapsedTime;
    const labels = { route, method: req.method, status: String(reply.statusCode) };
    incCounter('benchu_http_requests_total', 'Total HTTP requests', 1, labels);
    observeHistogram('benchu_http_request_duration_ms', 'HTTP request duration (ms)', ms, labels);
    if (reply.statusCode >= 500) incCounter('benchu_http_errors_total', 'HTTP 5xx responses', 1);
    const params = req.params as { id?: string } | undefined;
    req.log.info(
      accessLogFields({
        traceId: String(req.id),
        method: req.method,
        // The SSE endpoint authenticates via `?token=` because EventSource
        // cannot set headers — never let a JWT reach the log pipeline.
        url: redactUrl(req.url),
        status: reply.statusCode,
        ms: Math.round(ms),
        userId: req.userId,
        route: req.routeOptions?.url,
        paramId: params?.id,
      }),
      'request',
    );
  });

  // ---- Infrastructure endpoints -----------------------------------------
  app.get('/api/health', async () => {
    const [rows] = await pool.query<any[]>('SELECT 1 AS ok');
    return {
      ok: rows[0]?.ok === 1,
      service: 'benchu-canvas-api',
      time: Date.now(),
      queue: {
        mode: redisAvailable() ? 'redis-streams' : 'db-poll',
        depth: await queueDepth(),
        worker: runner?.mode ?? 'external',
      },
      moderation: {
        input: env.moderation.enabled,
        // Surfacing this in health makes "we forgot to configure the classifier"
        // visible to ops instead of a silent compliance gap.
        output: outputModerationActive(),
      },
    };
  });

  /** Liveness: the process is up. Never touches a dependency. */
  app.get('/api/live', async (_req, reply) => reply.code(200).send({ ok: true }));

  /** Readiness: can serve traffic (DB reachable). Drives LB / k8s probes. */
  app.get('/api/ready', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return reply.code(200).send({ ok: true });
    } catch (err) {
      return reply.code(503).send({ ok: false, error: 'DB_UNAVAILABLE', message: (err as Error).message });
    }
  });

  app.get('/api/metrics', async (req, reply) => {
    if (env.metricsToken) {
      const supplied = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (supplied !== env.metricsToken) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: '指标端点需要鉴权' });
      }
    }
    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return renderPrometheus({
      benchu_queue_depth: await queueDepth(),
      // Scrape-time gauges that require a query. Keeping them here (rather than
      // in a background timer) means a scrape always reflects the current state.
      benchu_tasks_running_stale: await staleRunningCount(),
      benchu_reconcile_issues: await reconcileIssueCount(),
    });
  });

  // ---- Business routes ---------------------------------------------------
  await app.register(authRoutes);
  await app.register(generationRoutes);
  await app.register(assetRoutes);
  await app.register(creditRoutes);
  await app.register(modelRoutes);
  await app.register(mediaRoutes);
  await app.register(tenantRoutes);
  await app.register(apiKeyRoutes);
  await app.register(billingRoutes);
  await app.register(canvasRoutes);
  await app.register(adminRoutes);
}

export async function startApi() {
  installConfiguredProviders();
  // Stripe Checkout registers only when PAYMENT_PROVIDER=stripe and both
  // secrets are set. A missing secret leaves no active gateway; mock is not
  // substituted. Mock itself is still refused in production.
  const stripeReady = installConfiguredStripeGateway();
  if (env.payments.provider === 'stripe' && !stripeReady) {
    app.log.warn(
      'PAYMENT_PROVIDER=stripe but STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is empty; Stripe was not registered',
    );
  }
  // Alipay registers only when PAYMENT_PROVIDER=alipay and the app id, merchant
  // private key, and Alipay public key are all set. Missing secrets leave no
  // active gateway; mock is not substituted.
  const alipayReady = installConfiguredAlipayGateway();
  if (env.payments.provider === 'alipay' && !alipayReady) {
    app.log.warn(
      'PAYMENT_PROVIDER=alipay but ALIPAY_APP_ID, ALIPAY_PRIVATE_KEY, or ALIPAY_PUBLIC_KEY is empty; Alipay was not registered',
    );
  }
  // WeChat Pay registers only when PAYMENT_PROVIDER=wechat and every required
  // secret is set. Missing secrets leave no active gateway; mock is not substituted.
  const wechatReady = installConfiguredWechatGateway();
  if (env.payments.provider === 'wechat' && !wechatReady) {
    app.log.warn(
      'PAYMENT_PROVIDER=wechat but a required WeChat Pay secret is empty; WeChat Pay was not registered',
    );
  }
  await build();
  await app.listen({ port: env.port, host: env.host });

  // Anything left `queued` by a previous process is re-published, never
  // silently completed — a restart must not lose a paid task.
  if (EMBEDDED_WORKER) {
    runner = new QueueRunner();
    await runner.start();
    const orphans = await recoverOrphanTasks();
    for (const task of orphans) await enqueue(task.id, task.priority);
    if (orphans.length) app.log.info(`重新入队 ${orphans.length} 个未完成任务`);
  }
  reaper = startReaper();
  monthlyCreditScheduler = startMonthlyCreditScheduler(env.monthlyCreditIntervalMs);

  app.log.info(
    `API: http://${env.host}:${env.port}  |  DB: ${env.db.database}@${env.db.host}:${env.db.port}  |  storage: ${storageRoot}  |  worker: ${EMBEDDED_WORKER ? 'embedded' : 'external'}`,
  );
  reportModerationStatus(app.log);
}

let shutdownPromise: Promise<void> | undefined;

async function performShutdown(signal: string) {
  app.log.info(`收到 ${signal}，开始优雅退出…`);
  if (reaper) clearInterval(reaper);
  if (monthlyCreditScheduler) clearInterval(monthlyCreditScheduler);
  // Stop accepting new HTTP work immediately, but let active requests settle
  // while the embedded worker commits any render already in flight.
  const closeApp = app.close().catch(() => {});
  await runner?.stop();
  await closeApp;
  await closeRedis();
  await pool.end().catch(() => {});
  await stopTelemetry();
  process.exit(0);
}

function shutdown(signal: string) {
  shutdownPromise ??= performShutdown(signal);
  return shutdownPromise;
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
