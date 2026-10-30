import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolConnection } from 'mysql2/promise';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { query, queryOne, withTransaction, exec } from '../db/pool.js';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { missingReferenceMessage } from '../lib/reference-request.js';
import { referenceByteMessage } from '../lib/reference-bytes.js';
import { PROMPT_MAX_LENGTH, PROMPT_TOO_LONG } from '../lib/prompt-length.js';
import { creditReason } from '../lib/credit-reason.js';
import { generationSeed } from '../lib/task-seed.js';
import { idempotencyKeyFromHeader } from '../lib/idempotency-key.js';
import { frameDimensionMessage } from '../lib/frame-dimension.js';
import { generationFieldMessage } from '../lib/generation-field.js';
import { generationListType } from '../lib/generation-list-type.js';
import { replayTaskScope } from '../lib/generation-replay-scope.js';
import { resolvedVideoFrame } from '../lib/video-frame.js';
import { assertApiScope, rejectIfAccessRevoked, rejectIfClosed, requireAuth, scopedGenerationTypes } from '../middleware/auth.js';
import { verifyToken } from '../lib/jwt.js';
import { adjustCredits } from '../services/credits.js';
import { audit } from '../services/audit.js';
import {
  assertPromptAllowed,
  inputRejectionAudit,
  matchedSuspendsAccount,
  moderatePrompt,
} from '../services/moderation.js';
import { estimateCost, getModel, listRoutedModels, retryModelProblem, validateAgainstModel, type StoredModel } from '../services/models.js';
import { isProviderCircuitOpen, providerFor } from '../services/provider.js';
import {
  affordableAlternativeNames,
  alternativeNames,
  insufficientCreditsMessage,
  selectAutoModel,
  toRoutingCandidate,
  unavailableModelMessage,
} from '../services/model-routing.js';
import { enqueue } from '../services/queue.js';
import { missingNextAttemptColumn } from '../services/retry-schedule.js';
import { checkRateLimit } from '../services/ratelimit.js';
import { planForUser, precheckConcurrency, withQuotaTransaction } from '../services/plans.js';
import { storedQueuePriority, taskPriorityForPlan } from '../services/queue-lane.js';
import { cursorStamp, generationCursorSql, parseGenerationPage } from '../services/generation-page.js';
import {
  loadOutputs,
  loadTask,
  outputDtos,
  refundTask,
  suspendAccountForSevereContent,
  type TaskRow,
} from '../services/pipeline.js';
import { refreshCookieName, userIdFromRefreshCookie } from '../services/sessions.js';
import { ensurePersonalOrg, getMembership } from '../services/orgs.js';
import { withTenant } from '../services/tenant-query.js';
import { storedTraceId } from '../lib/worker-log.js';
import { bucketRef, emptyRefs, taskDto, type RefRow } from '../lib/dto.js';
import { removeObject } from '../services/storage.js';

const createSchema = z.object({
  type: z.enum(['image', 'video']).default('video'),
  prompt: z.string().trim().min(1, '提示词不能为空').max(PROMPT_MAX_LENGTH, PROMPT_TOO_LONG),
  modelId: z.string().min(1).max(64),
  /** Client-supplied label kept for display only; the price comes from the registry. */
  modelName: z.string().min(1).max(120).optional(),
  resolution: z.string().max(16).optional().nullable(),
  width: z.number().int().min(0).max(8192).default(0),
  height: z.number().int().min(0).max(8192).default(0),
  duration: z.number().int().min(0).max(120).default(0),
  count: z.number().int().min(1).max(8).default(1),
  /** Ignored — retained for older clients. Billing is always server-computed. */
  credits: z.number().int().min(0).max(100000).optional(),
  seed: z.string().optional(),
  refAssetIds: z.array(z.string()).max(30).optional().default([]),
  visibility: z.enum(['private', 'org']).default('private'),
});


async function refsByTask(ids: string[]) {
  if (ids.length === 0) return new Map<string, ReturnType<typeof emptyRefs>>();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await query<RefRow>(
    `SELECT gr.task_id, a.id, a.kind, a.filename, a.url, a.size
       FROM generation_refs gr
       JOIN assets a ON a.id = gr.asset_id
      WHERE gr.task_id IN (${placeholders})`,
    ids,
  );
  return bucketRef(rows);
}

/** Loads one task plus its refs and outputs, ready for the client. */
async function hydrate(task: TaskRow, includeRefs = true) {
  const [refs, outputs] = await Promise.all([
    includeRefs ? refsByTask([task.id]) : Promise.resolve(new Map()),
    loadOutputs(task.id),
  ]);
  return taskDto(task, { refs: refs.get(task.id), outputs, mine: includeRefs });
}

function clientIp(req: FastifyRequest): string | null {
  return req.ip ?? null;
}

function candidateFor(model: StoredModel) {
  const resolved = providerFor(model);
  return toRoutingCandidate(model, {
    remote: resolved.remote,
    circuitOpen: isProviderCircuitOpen(resolved.id),
  });
}

const INSUFFICIENT_CREDITS_MESSAGE = '积分不足，请充值后再试';

/**
 * Affordable names for the refusal copy. A catalogue failure keeps the names
 * empty and the original sentence. The selected model id is only excluded.
 */
async function creditsShortageMessage(input: {
  kind: 'image' | 'video';
  balance: number;
  excludeId: string;
  duration: number;
  count: number;
}): Promise<string> {
  try {
    const pool = await listRoutedModels(input.kind);
    const names = affordableAlternativeNames(
      pool.map((model) => {
        const route = candidateFor(model);
        const durationOk = !(
          input.kind === 'video' &&
          model.maxDuration !== null &&
          model.maxDuration < input.duration
        );
        return {
          id: route.id,
          name: route.name,
          kind: route.kind,
          enabled: route.enabled,
          circuitOpen: route.circuitOpen,
          sortWeight: route.sortWeight,
          priceAmount: route.priceAmount,
          cost: estimateCost({ model, duration: input.duration, count: input.count }),
          durationOk,
        };
      }),
      { kind: input.kind, balance: input.balance, excludeId: input.excludeId },
    );
    return insufficientCreditsMessage(names);
  } catch {
    return INSUFFICIENT_CREDITS_MESSAGE;
  }
}

async function missingModelMessage(kind: 'image' | 'video'): Promise<string> {
  try {
    const pool = await listRoutedModels(kind);
    return unavailableModelMessage(alternativeNames(pool.map(candidateFor), kind));
  } catch {
    return unavailableModelMessage([]);
  }
}

/**
 * An explicit id keeps today's lookup. `auto` ranks the catalogue only when
 * no registry row owns that id. The chosen model then hits the existing
 * duration and credit checks; nothing is charged before those checks.
 */
async function resolveGenerationModel(modelId: string, kind: 'image' | 'video'): Promise<StoredModel> {
  if (modelId === 'auto') {
    const registered = await getModel('auto');
    // A real row named auto owns that id even when it has been disabled.
    if (registered) {
      if (registered.enabled === false) throw badRequest(await missingModelMessage(kind));
      return registered;
    }
    const pool = await listRoutedModels(kind);
    const candidates = pool.map(candidateFor);
    const chosen = selectAutoModel(candidates, kind);
    const model = chosen ? pool.find((item) => item.id === chosen.id) : undefined;
    if (!model) throw badRequest(unavailableModelMessage(alternativeNames(candidates, kind)));
    return model;
  }

  const model = await getModel(modelId);
  if (!model || model.enabled === false) throw badRequest(await missingModelMessage(kind));
  return model;
}

/** Viewers are read-only. Other roles, including API keys resolved as editor, may generate. */
export function assertCanGenerate(role: string | undefined): void {
  if (role === 'viewer') throw forbidden('只读成员无法创建生成任务');
}

/** Plan ceiling on video length. Images and in-limit videos pass through. */
export function assertVideoPlanDuration(type: string, duration: number, maxDuration: number): void {
  if (type === 'video' && duration > maxDuration) {
    throw badRequest(`当前套餐最长支持 ${maxDuration} 秒视频，请升级套餐或缩短时长`);
  }
}

type RetryRefKind = 'image' | 'video' | 'audio';

const RETRY_REF_KINDS_SQL = `SELECT a.kind AS kind
     FROM generation_refs gr
     JOIN assets a ON a.id = gr.asset_id
    WHERE gr.task_id = ?`;

/**
 * Stored task against the model id already written on the row. A missing or
 * disabled id throws the usual offline error and is never replaced by auto
 * selection. Then reject duration, count, and ref kinds. Call before rate
 * limits, and again on the locked row before credits move.
 */
async function assertRetryModelAccepts(
  task: { model_id: string; type: 'image' | 'video'; duration: number; count: number },
  taskId: string,
  conn?: PoolConnection,
): Promise<void> {
  const model = await getModel(task.model_id);
  if (!model || model.enabled === false) throw badRequest(await missingModelMessage(task.type));
  let refRows: Array<{ kind: RetryRefKind }>;
  if (conn) {
    const [rows] = await conn.query<any[]>(RETRY_REF_KINDS_SQL, [taskId]);
    refRows = rows as Array<{ kind: RetryRefKind }>;
  } else {
    refRows = await query<{ kind: RetryRefKind }>(RETRY_REF_KINDS_SQL, [taskId]);
  }
  const problem = retryModelProblem(model, {
    type: task.type,
    duration: task.duration,
    count: task.count,
    refKinds: refRows.map((row) => row.kind),
  });
  if (problem) throw badRequest(problem);
}

export async function generationRoutes(app: FastifyInstance) {
  // 列表
  app.get('/api/generations', { preHandler: [requireAuth] }, async (req) => {
    const { limit, before, beforeId } = req.query as {
      limit?: string;
      before?: string;
      beforeId?: string;
    };
    const listType = generationListType(req.query as { type?: unknown });
    if (listType.error) throw badRequest(listType.error);
    const type = listType.type;
    const page = parseGenerationPage({ limit, before, beforeId });
    if (page.error) throw badRequest(page.error);
    assertApiScope(req, 'generate:image', 'generate:video');
    const allowedTypes = scopedGenerationTypes(req.apiScopes);
    if (type && allowedTypes && !allowedTypes.includes(type as 'image' | 'video')) {
      throw forbidden('API Key 缺少所需权限');
    }
    const tenant = withTenant({ userId: req.userId!, orgId: req.orgId });
    const readFilter = tenant.taskReadSql();
    const readParams = tenant.taskReadParams();
    const typeSql = type
      ? 'AND type = ?'
      : allowedTypes
        ? `AND type IN (${allowedTypes.map(() => '?').join(',')})`
        : '';
    const typeParams = type ? [type] : (allowedTypes ?? []);
    const cursor = generationCursorSql(page.cursor);
    const rows = await query<TaskRow>(
      `SELECT * FROM generation_tasks WHERE ${readFilter} ${typeSql} ${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...readParams, ...typeParams, ...cursor.params, page.limit],
    );

    const ids = rows.map((r) => r.id);
    const [refs, outputs] = await Promise.all([
      refsByTask(ids),
      ids.length
        ? query<{ task_id: string } & Record<string, any>>(
            `SELECT * FROM task_outputs WHERE task_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort_order ASC`,
            ids,
          )
        : Promise.resolve([]),
    ]);

    const outputsByTask = new Map<string, any[]>();
    for (const o of outputs) {
      const list = outputsByTask.get(o.task_id) ?? [];
      list.push(o);
      outputsByTask.set(o.task_id, list);
    }

    const last = rows.length === page.limit ? rows[rows.length - 1] : null;
    const stamp = last ? cursorStamp(last.created_at) : null;
    return {
      items: rows.map((r) => taskDto(r, {
        // Reference assets stay private even when the generated output is shared.
        refs: r.user_id === req.userId ? refs.get(r.id) : emptyRefs(),
        outputs: outputsByTask.get(r.id),
        mine: r.user_id === req.userId,
      })),
      nextCursor: last && stamp ? { createdAt: stamp, id: last.id } : null,
    };
  });

  // 创建（幂等：Idempotency-Key 重复提交返回同一条且不重复扣费）
  app.post('/api/generations', { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path[0];
      if (field === 'width' || field === 'height') {
        const body = req.body;
        const raw = typeof body === 'object' && body !== null ? (body as { width?: unknown; height?: unknown }) : {};
        const dimensionMessage = frameDimensionMessage(raw.width, raw.height);
        if (dimensionMessage) throw badRequest(dimensionMessage);
      }
      const fieldMessage = generationFieldMessage(field);
      if (fieldMessage) throw badRequest(fieldMessage);
      throw badRequest(issue?.message ?? '参数错误');
    }
    const d = parsed.data;

    // RBAC: viewers are read-only. API-key callers are resolved as `editor`.
    assertCanGenerate(req.role);
    if (d.visibility === 'org' && !req.orgId) throw badRequest('选择组织后才能共享生成结果');

    assertApiScope(req, `generate:${d.type}`);

    // 合法键且已有本用户任务时先重放：不占生成限流，不再审核，不扣费。
    // 超长键这里不报错，仍落到下面的限流之后。
    const replayKey = idempotencyKeyFromHeader(req.headers['idempotency-key']);
    if (replayKey.key) {
      const existing = await queryOne<TaskRow>(
        'SELECT * FROM generation_tasks WHERE user_id = ? AND idempotency_key = ? LIMIT 1',
        [req.userId!, replayKey.key],
      );
      if (existing) {
        const replayDenied = replayTaskScope(req.apiScopes, existing.type);
        if (replayDenied) throw forbidden(replayDenied);
        return reply.code(200).send({ item: await hydrate(existing), idempotent: true });
      }
    }

    // Rate limits gate the *creation call*, not queue throughput — the worker
    // and its concurrency are the actual generation governor.
    // The plan's rpm is the per-user ceiling; the fixed numbers are the
    // platform-wide abuse ceiling that applies even to enterprise plans.
    const plan = await planForUser(req.userId!);

    // Fast path so the common rejection does not open a transaction.
    // The authoritative reservation happens inside the transaction below.
    await precheckConcurrency(req.userId!, plan.maxConcurrent);

    await checkRateLimit(
      `gen:u:${req.userId}`,
      Math.min(plan.rpm, 600),
      60,
      '生成请求过于频繁，请稍后再试',
    );
    await checkRateLimit(
      `gen:ip:${req.ip}`,
      120,
      60,
      '请求过于频繁，请稍后再试',
    );

    // 两道限流都通过后立刻拒绝超长键，不再审核、停用或解析模型。
    const headerKey = idempotencyKeyFromHeader(req.headers['idempotency-key']);
    if (headerKey.error) throw badRequest(headerKey.error);

    // 1) Content moderation runs before any money moves. Record the rejection,
    // then throw the same CONTENT_REJECTED. No task row and no credit charge yet.
    const rejected = inputRejectionAudit(d.prompt);
    if (rejected) {
      await audit({
        userId: req.userId!,
        orgId: req.orgId,
        action: rejected.action,
        ip: clientIp(req),
        ua: req.headers['user-agent'] ?? null,
        meta: rejected.meta,
      });
      const verdict = moderatePrompt(d.prompt);
      if (!verdict.ok && matchedSuspendsAccount(verdict.matched)) {
        await suspendAccountForSevereContent(req.userId!, 'input');
      }
    }
    assertPromptAllowed(d.prompt);

    // 2) Resolve the model from the registry — never trust client pricing.
    const model = await resolveGenerationModel(d.modelId, d.type);
    if (model.kind !== d.type) throw badRequest('模型类型与任务类型不匹配');

    const { key: idempotencyKey, error: idempotencyError } = idempotencyKeyFromHeader(req.headers['idempotency-key']);
    if (idempotencyError) throw badRequest(idempotencyError);

    if (idempotencyKey) {
      const existing = await queryOne<TaskRow>(
        'SELECT * FROM generation_tasks WHERE user_id = ? AND idempotency_key = ? LIMIT 1',
        [req.userId!, idempotencyKey],
      );
      if (existing) {
        const replayDenied = replayTaskScope(req.apiScopes, existing.type);
        if (replayDenied) throw forbidden(replayDenied);
        return reply.code(200).send({ item: await hydrate(existing), idempotent: true });
      }
    }

    const id = randomUUID();
    const seed = generationSeed({ seed: d.seed, modelId: d.modelId, now: Date.now(), id });

    // 3) Verify reference assets belong to the caller.
    const refIds = d.refAssetIds ?? [];
    let validRefs: { id: string; kind: 'image' | 'video' | 'audio'; size: number }[] = [];
    if (refIds.length > 0) {
      const ph = refIds.map(() => '?').join(',');
      const tenant = withTenant({ userId: req.userId!, orgId: req.orgId });
      validRefs = await query<{ id: string; kind: 'image' | 'video' | 'audio'; size: number }>(
        `SELECT id, kind, size FROM assets WHERE ${tenant.assetReadSql()} AND id IN (${ph})`,
        [...tenant.assetReadParams(), ...refIds],
      );
    }
    const refOrder = new Map(refIds.map((refId, index) => [refId, index]));
    validRefs.sort((a, b) => (refOrder.get(a.id) ?? refIds.length) - (refOrder.get(b.id) ?? refIds.length));
    const missingRefs = missingReferenceMessage(refIds, validRefs.map((r) => r.id));
    if (missingRefs) throw badRequest(missingRefs);
    const oversizedRef = referenceByteMessage(
      validRefs.map((row) => ({ kind: row.kind, size: Number(row.size) })),
    );
    if (oversizedRef) throw badRequest(oversizedRef);

    const invalid = validateAgainstModel(model, {
      duration: d.duration,
      count: d.count,
      refCount: validRefs.length,
      refKinds: validRefs.map((r) => r.kind),
    });
    if (invalid) throw badRequest(invalid);

    // Plan ceiling on top of the model ceiling: a free account cannot request a
    // 30s render just because the model supports it.
    assertVideoPlanDuration(d.type, d.duration, plan.maxDuration);

    // 4) Server-computed cost + up-front quota check (fail before charging).
    // The refusal sentence is fixed here, after the rate limits and before any
    // credit movement, so a later race uses the same copy.
    const cost = estimateCost({ model, duration: d.duration, count: d.count });
    const balanceRow = await queryOne<{ credits: number }>('SELECT credits FROM users WHERE id = ?', [req.userId!]);
    const balance = Number(balanceRow?.credits ?? 0);
    const creditsMessage = await creditsShortageMessage({
      kind: d.type,
      balance,
      excludeId: model.id,
      duration: d.duration,
      count: d.count,
    });
    if (balance < cost) {
      return reply.code(402).send({ error: 'INSUFFICIENT_CREDITS', message: creditsMessage });
    }

    let task: TaskRow;
    try {
      // One connection carries the quota lock AND the transaction, so a burst
      // of parallel creates cannot exhaust the pool (see withQuotaTransaction).
      task = await withQuotaTransaction(req.userId!, plan.maxConcurrent, async (conn) => {
        if (cost > 0) {
          await adjustCredits(conn, req.userId!, -cost, creditReason('生成任务扣费 · ', model.name), id);
        }
        const frame = resolvedVideoFrame(d.type, d.resolution, d.width, d.height);
        await conn.query(
          `INSERT INTO generation_tasks
            (id, org_id, visibility, user_id, type, prompt, model_id, model_name, resolution, width, height, duration, \`count\`, status, progress, seed, credits_cost, idempotency_key, priority, trace_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
          [
            id,
            req.orgId ?? null,
            d.visibility,
            req.userId!,
            d.type,
            d.prompt,
            model.id,
            model.name,
            d.resolution ?? null,
            frame.width,
            frame.height,
            d.duration,
            d.count,
            seed,
            cost,
            idempotencyKey,
            taskPriorityForPlan(plan.id),
            storedTraceId(req.id),
          ],
        );
        if (validRefs.length > 0) {
          const values = validRefs.map((r) => [id, r.id, r.kind]);
          await conn.query('INSERT INTO generation_refs (task_id, asset_id, kind) VALUES ?', [values]);
        }
        const [rows] = await conn.query<any[]>('SELECT * FROM generation_tasks WHERE id = ?', [id]);
        return rows[0] as TaskRow;
      });
    } catch (err: any) {
      if (err?.code === 'ER_DUP_ENTRY' && idempotencyKey) {
        const existing = await queryOne<TaskRow>(
          'SELECT * FROM generation_tasks WHERE user_id = ? AND idempotency_key = ? LIMIT 1',
          [req.userId!, idempotencyKey],
        );
        if (existing) {
          const replayDenied = replayTaskScope(req.apiScopes, existing.type);
          if (replayDenied) throw forbidden(replayDenied);
          return reply.code(200).send({ item: await hydrate(existing), idempotent: true });
        }
      }
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_CREDITS') {
        return reply.code(402).send({ error: 'INSUFFICIENT_CREDITS', message: creditsMessage });
      }
      throw err;
    }

    await audit({
      userId: req.userId!,
      action: 'task.create',
      target: id,
      ip: clientIp(req),
      ua: req.headers['user-agent'] ?? null,
      orgId: req.orgId,
      meta: {
        model: model.id,
        type: d.type,
        cost,
        prompt: d.prompt.slice(0, 500),
        visibility: d.visibility,
      },
    });

    // 5) Hand off to the queue. If Redis is down the runner polls the DB,
    //    so a failure to enqueue is recoverable rather than fatal.
    await enqueue(id, storedQueuePriority(task.priority));

    return reply.code(201).send({ item: await hydrate(task) });
  });

  // SSE 进度推送
  // EventSource cannot set an Authorization header, so auth comes from the
  // httpOnly refresh cookie (preferred). `?token=` still accepts an access
  // JWT for SDK clients and is redacted from logs. Closed, suspended and
  // cutoff tokens are rejected; an invalid token falls back to the cookie.
  app.get('/api/generations/:id/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { token } = req.query as { token?: string };
    const bearer = token || (req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '');

    let userId: string | null = null;
    let email = '';
    let accessIat: number | undefined;
    if (bearer) {
      try {
        const payload = verifyToken(bearer);
        await rejectIfClosed(payload.sub);
        await rejectIfAccessRevoked(payload.sub, payload.iat);
        userId = payload.sub;
        email = payload.email;
        accessIat = payload.iat;
      } catch (err) {
        if (err instanceof ApiError && err.message !== '未登录或登录已过期') {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        userId = null;
      }
    }
    // Fall back to the session cookie so no JWT has to appear in a URL.
    if (!userId) {
      userId = await userIdFromRefreshCookie((req as any).cookies?.[refreshCookieName]);
    }
    if (!userId) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录或登录已过期' });
    }
    try {
      await rejectIfClosed(userId);
    } catch (err) {
      if (err instanceof ApiError) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
    }
    const sessionUserId = userId;

    // EventSource cannot attach custom headers, so browsers pass the selected
    // workspace here.  The membership lookup below is still authoritative.
    const requestedOrg = ((req.query as { orgId?: string }).orgId ?? (req.headers['x-org-id'] as string | undefined))?.trim();
    const orgId = requestedOrg
      ? await getMembership(userId, requestedOrg).then((role) => role ? requestedOrg : undefined)
      : email ? await ensurePersonalOrg(userId, email) : undefined;
    const tenant = withTenant({ userId, orgId });
    const row = await queryOne<TaskRow>(
      `SELECT * FROM generation_tasks WHERE id = ? AND ${tenant.taskReadSql()}`,
      [id, ...tenant.taskReadParams()],
    );
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: '生成任务不存在' });

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let last = '';
    let closed = false;
    const send = (payload: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearTimeout(deadline);
      try {
        reply.raw.end();
      } catch {
        /* already closed */
      }
    };

    const tick = async () => {
      if (closed) return;
      try {
        await rejectIfClosed(sessionUserId);
        if (accessIat !== undefined) await rejectIfAccessRevoked(sessionUserId, accessIat);
        const cur = await queryOne<TaskRow>('SELECT * FROM generation_tasks WHERE id = ?', [id]);
        if (!cur) {
          send({ error: 'NOT_FOUND' });
          cleanup();
          return;
        }
        const snapshot = `${cur.status}:${cur.progress}`;
        if (snapshot !== last) {
          last = snapshot;
          // Terminal frames carry the signed output URLs.
          send({ item: await hydrate(cur, cur.user_id === userId) });
        }
        if (cur.status === 'done' || cur.status === 'failed') {
          send({ done: true, status: cur.status });
          cleanup();
        }
      } catch (err) {
        if (err instanceof ApiError) {
          send({ error: err.code, message: err.message });
          cleanup();
          return;
        }
        /* transient DB error — retry next tick */
      }
    };

    const timer = setInterval(tick, 500);
    const deadline = setTimeout(cleanup, 15 * 60 * 1000);
    req.raw.on('close', cleanup);

    void tick();
  });

  // 详情
  app.get('/api/generations/:id', { preHandler: [requireAuth] }, async (req) => {
    const { id } = req.params as { id: string };
    const tenant = withTenant({ userId: req.userId!, orgId: req.orgId });
    const row = await queryOne<TaskRow>(
      `SELECT * FROM generation_tasks WHERE id = ? AND ${tenant.taskReadSql()}`,
      [id, ...tenant.taskReadParams()],
    );
    if (!row) throw notFound('生成任务不存在');
    assertApiScope(req, `generate:${row.type}`);
    return { item: await hydrate(row, row.user_id === req.userId) };
  });

  // 重试：从失败态回到队列，重新扣费
  app.post('/api/generations/:id/retry', { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    assertCanGenerate(req.role);
    const existing = await queryOne<{
      type: 'image' | 'video';
      duration: number;
      model_id: string;
      count: number;
      credits_cost: number;
    }>(
      'SELECT type, duration, model_id, `count`, credits_cost FROM generation_tasks WHERE id = ? AND user_id = ?',
      [id, req.userId!],
    );
    if (!existing) throw notFound('生成任务不存在');
    assertApiScope(req, `generate:${existing.type}`);
    const plan = await planForUser(req.userId!);
    assertVideoPlanDuration(existing.type, existing.duration, plan.maxDuration);
    await assertRetryModelAccepts(existing, id);
    await precheckConcurrency(req.userId!, plan.maxConcurrent, id);
    const retryCost = Number(existing.credits_cost);
    if (retryCost > 0) {
      const balanceRow = await queryOne<{ credits: number }>('SELECT credits FROM users WHERE id = ?', [req.userId!]);
      const balance = Number(balanceRow?.credits ?? 0);
      if (balance < retryCost) {
        const message = await creditsShortageMessage({
          kind: existing.type,
          balance,
          excludeId: existing.model_id,
          duration: Number(existing.duration),
          count: Number(existing.count),
        });
        return reply.code(402).send({ error: 'INSUFFICIENT_CREDITS', message });
      }
    }
    await checkRateLimit(
      `gen:u:${req.userId}`,
      Math.min(plan.rpm, 600),
      60,
      '生成请求过于频繁，请稍后再试',
    );
    await checkRateLimit(
      `gen:ip:${req.ip}`,
      120,
      60,
      '请求过于频繁，请稍后再试',
    );
    let retried: { row: TaskRow; objectKeys: string[] } | null;
    try {
      retried = await withQuotaTransaction(req.userId!, plan.maxConcurrent, async (conn) => {
      const [rows] = await conn.query<any[]>(
        'SELECT * FROM generation_tasks WHERE id = ? AND user_id = ? FOR UPDATE',
        [id, req.userId!],
      );
      const row = rows[0] as TaskRow | undefined;
      if (!row) throw notFound('生成任务不存在');
      assertApiScope(req, `generate:${row.type}`);
      if (row.status === 'queued' || row.status === 'running') return null;
      const [outputs] = await conn.query<any[]>('SELECT object_key FROM task_outputs WHERE task_id = ?', [id]);
      assertVideoPlanDuration(row.type, row.duration, plan.maxDuration);
      await assertRetryModelAccepts(row, id, conn);
      if (row.credits_cost > 0) {
        await adjustCredits(conn, req.userId!, -row.credits_cost, creditReason('重试扣费 · ', row.model_name), id);
      }
      const retrySql = `UPDATE generation_tasks
            SET status = 'queued', progress = 0, error = NULL, error_code = NULL,
                finished_at = NULL, refunded_at = NULL, heartbeat_at = NULL, started_at = NULL`;
      try {
        await conn.query(`${retrySql}, next_attempt_at = NULL WHERE id = ?`, [id]);
      } catch (err) {
        if (!missingNextAttemptColumn(err)) throw err;
        await conn.query(`${retrySql} WHERE id = ?`, [id]);
      }
      await conn.query('DELETE FROM task_outputs WHERE task_id = ?', [id]);
      return { row, objectKeys: outputs.map((item) => String(item.object_key)) };
    }, id);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_CREDITS') {
        const raced = await queryOne<{ credits: number }>('SELECT credits FROM users WHERE id = ?', [req.userId!]);
        const message = await creditsShortageMessage({
          kind: existing.type,
          balance: Number(raced?.credits ?? 0),
          excludeId: existing.model_id,
          duration: Number(existing.duration),
          count: Number(existing.count),
        });
        return reply.code(402).send({ error: 'INSUFFICIENT_CREDITS', message });
      }
      throw err;
    }
    if (!retried) return reply.code(409).send({ error: 'CONFLICT', message: '任务正在进行中' });
    await Promise.allSettled(retried.objectKeys.map((key) => removeObject(key)));

    await audit({ userId: req.userId!, orgId: req.orgId, action: 'task.retry', target: id });
    await enqueue(id, storedQueuePriority(retried.row.priority));

    const updated = await loadTask(id);
    return { item: await hydrate(updated!) };
  });

  // 取消（排队中或运行中）
  app.post('/api/generations/:id/cancel', { preHandler: [requireAuth] }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await queryOne<TaskRow>(
      'SELECT * FROM generation_tasks WHERE id = ? AND user_id = ?',
      [id, req.userId!],
    );
    if (!row) throw notFound('生成任务不存在');
    assertApiScope(req, `generate:${row.type}`);
    if (row.status === 'done' || row.status === 'failed') {
      return { item: await hydrate(row), cancelled: false };
    }
    const cancelled = await exec(
      "UPDATE generation_tasks SET status = 'failed', error = '用户已取消', error_code = 'CANCELLED', finished_at = NOW() WHERE id = ? AND status IN ('queued','running')",
      [id],
    );
    if (cancelled.affectedRows === 0) {
      const current = await loadTask(id);
      return { item: await hydrate(current!), cancelled: false };
    }
    await refundTask(id, 'CANCELLED');
    await audit({ userId: req.userId!, orgId: req.orgId, action: 'task.cancel', target: id });
    const updated = await loadTask(id);
    return { item: await hydrate(updated!), cancelled: true };
  });

  // 删除单个
  app.delete('/api/generations/:id', { preHandler: [requireAuth] }, async (req) => {
    const { id } = req.params as { id: string };
    const gate = await queryOne<{ type: string }>('SELECT type FROM generation_tasks WHERE id = ? AND user_id = ?', [
      id,
      req.userId!,
    ]);
    if (!gate) throw notFound('生成任务不存在');
    assertApiScope(req, `generate:${gate.type}`);
    const deleted = await withTransaction(async (conn) => {
      const [tasks] = await conn.query<any[]>(
        "SELECT id FROM generation_tasks WHERE id = ? AND user_id = ? AND status IN ('done','failed') FOR UPDATE",
        [id, req.userId!],
      );
      if (tasks.length === 0) return null;
      const [outputs] = await conn.query<any[]>('SELECT object_key FROM task_outputs WHERE task_id = ?', [id]);
      await conn.query('DELETE FROM generation_tasks WHERE id = ?', [id]);
      return outputs.map((item) => String(item.object_key));
    });
    if (!deleted) {
      const exists = await queryOne('SELECT id FROM generation_tasks WHERE id = ? AND user_id = ?', [id, req.userId!]);
      if (!exists) throw notFound('生成任务不存在');
      return { ok: false, reason: 'RUNNING' };
    }
    const cleanup = await Promise.allSettled(deleted.map((key) => removeObject(key)));
    const cleanupFailures = cleanup.filter((result) => result.status === 'rejected').length;
    await audit({ userId: req.userId!, orgId: req.orgId, action: 'task.delete', target: id });
    return { ok: true, cleanupFailures };
  });

  // 批量删除
  app.post('/api/generations/bulk-delete', { preHandler: [requireAuth] }, async (req) => {
    const body = z.object({ ids: z.array(z.string()).min(1) }).safeParse(req.body);
    if (!body.success) throw badRequest('参数错误');
    assertApiScope(req, 'generate:image', 'generate:video');
    const ids = body.data.ids;
    const placeholders = ids.map(() => '?').join(',');
    const removed = await withTransaction(async (conn) => {
      const [tasks] = await conn.query<any[]>(
        `SELECT id, type FROM generation_tasks WHERE user_id = ? AND status IN ('done','failed') AND id IN (${placeholders}) FOR UPDATE`,
        [req.userId!, ...ids],
      );
      for (const task of tasks) assertApiScope(req, `generate:${task.type}`);
      const taskIds = tasks.map((task) => String(task.id));
      if (taskIds.length === 0) return { taskIds, objectKeys: [] as string[] };
      const lockedPlaceholders = taskIds.map(() => '?').join(',');
      const [outputs] = await conn.query<any[]>(
        `SELECT object_key FROM task_outputs WHERE task_id IN (${lockedPlaceholders})`,
        taskIds,
      );
      await conn.query(`DELETE FROM generation_tasks WHERE id IN (${lockedPlaceholders})`, taskIds);
      return { taskIds, objectKeys: outputs.map((item) => String(item.object_key)) };
    });
    const cleanup = await Promise.allSettled(removed.objectKeys.map((key) => removeObject(key)));
    const cleanupFailures = cleanup.filter((result) => result.status === 'rejected').length;
    await audit({
      userId: req.userId!,
      orgId: req.orgId,
      action: 'task.bulk_delete',
      meta: { requested: ids.length, deleted: removed.taskIds.length, cleanupFailures },
    });
    const deletedIds = removed.taskIds;
    return { ok: true, deleted: deletedIds.length, deletedIds, cleanupFailures };
  });

  // 产物列表（含签名 URL）
  app.get('/api/generations/:id/outputs', { preHandler: [requireAuth] }, async (req) => {
    const { id } = req.params as { id: string };
    const tenant = withTenant({ userId: req.userId!, orgId: req.orgId });
    const row = await queryOne<TaskRow>(
      `SELECT * FROM generation_tasks WHERE id = ? AND ${tenant.taskReadSql()}`,
      [id, ...tenant.taskReadParams()],
    );
    if (!row) throw notFound('生成任务不存在');
    assertApiScope(req, `generate:${row.type}`);
    return { items: outputDtos(await loadOutputs(id)) };
  });
}
