import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { query, queryOne, withTransaction, exec } from '../db/pool.js';
import { env } from '../env.js';
import { keys, putObjectFromPath, removeObject, signedUrl } from './storage.js';
import { creditReason } from '../lib/credit-reason.js';
import { renderFrame } from '../lib/render-frame.js';
import { renderDuration } from '../lib/render-duration.js';
import { renderDuration } from '../lib/render-duration.js';
import { recordedJobId, successJobIdUpdate } from '../lib/provider-job-id.js';
import { storedCostActual } from '../lib/stored-cost.js';
import { outputExtension } from '../lib/output-extension.js';
import { storedMime } from '../lib/stored-mime.js';
import { adjustCredits } from './credits.js';
import { audit } from './audit.js';
import { getModel, type StoredModel } from './models.js';
import { circuitFailoverAllowed, selectFallback, toRoutingCandidate } from './model-routing.js';
import {
  ProviderError,
  isProviderCircuitOpen,
  isSimulated,
  providerFor,
  recordProviderFailure,
  recordProviderSuccess,
} from './provider.js';
import { contentRejectionAuditMeta, moderateOutputs, reasonSuspendsAccount } from './moderation.js';
import { REVOKE_SESSIONS_SQL, formatMysqlDateTime } from './account-erasure.js';
import { planForUser } from './plans.js';
import { AigcLabelError, applyAigcLabel, planWatermarkRequired } from './aigc-label.js';
import {
  configuredC2paCredentials,
  maybeSignOutput,
  type C2paCredentials,
  type C2paSigner,
} from './c2pa-sign.js';
import { createThumbnailFile, type ThumbnailScaler } from './thumbnail.js';
import { discardRenderTemp, isInsideUploadRoot, isolateUploadedOutput } from './output-source.js';
import { staleRecovery } from './stale-recovery.js';
import { createProgressThrottle } from './progress-throttle.js';
import { queuedReadySql, withNextAttemptColumn } from './retry-schedule.js';
import { storedQueuePriority, storedQueuePrioritySql } from './queue-lane.js';
import { workerTaskFields } from '../lib/worker-log.js';

export type TaskRow = {
  id: string;
  user_id: string;
  org_id: string | null;
  visibility: 'private' | 'org';
  type: 'image' | 'video';
  prompt: string;
  model_id: string;
  model_name: string;
  resolution: string | null;
  width: number;
  height: number;
  duration: number;
  count: number;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  seed: string;
  result_url: string | null;
  poster_url: string | null;
  credits_cost: number;
  cost_actual: number;
  error: string | null;
  error_code: string | null;
  idempotency_key: string | null;
  priority: number;
  attempts: number;
  max_attempts: number;
  provider_job_id: string | null;
  trace_id?: string | null;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  refunded_at: string | null;
  created_at: string;
};

export type OutputRow = {
  id: string;
  task_id: string;
  kind: 'image' | 'video' | 'poster' | 'sprite' | 'audio' | 'thumbnail';
  object_key: string;
  mime: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  bytes: number | null;
  sha256: string | null;
  watermarked: number;
  sort_order: number;
};

export function loadTask(taskId: string) {
  return queryOne<TaskRow>('SELECT * FROM generation_tasks WHERE id = ? LIMIT 1', [taskId]);
}

/** CAS transition queued → running. Returns false if another worker won the race. */
export async function claimTask(taskId: string): Promise<boolean> {
  const result = await withNextAttemptColumn(
    () =>
      exec(
        `UPDATE generation_tasks
            SET status = 'running', started_at = NOW(), heartbeat_at = NOW(), progress = 1, error = NULL, error_code = NULL,
                next_attempt_at = NULL
          WHERE id = ? AND status = 'queued'`,
        [taskId],
      ),
    () =>
      exec(
        `UPDATE generation_tasks
            SET status = 'running', started_at = NOW(), heartbeat_at = NOW(), progress = 1, error = NULL, error_code = NULL
          WHERE id = ? AND status = 'queued'`,
        [taskId],
      ),
  );
  return result.affectedRows === 1;
}

export async function heartbeat(taskId: string): Promise<void> {
  await exec("UPDATE generation_tasks SET heartbeat_at = NOW() WHERE id = ? AND status = 'running'", [taskId]);
}

/**
 * Best-effort JPEG sidecar. Failures, timeouts, and a missing ffmpeg leave the
 * main object in place. The thumbnail inherits the source watermark flag and
 * is not written into result_url or poster_url.
 */
async function attachThumbnail(
  task: TaskRow,
  sourcePath: string,
  source: OutputRow,
  order: number,
  rows: OutputRow[],
  opts?: { signal?: AbortSignal; scaleImage?: ThumbnailScaler },
): Promise<number> {
  if (opts?.signal?.aborted) return order;
  let localPath: string | null = null;
  let objectKey: string | null = null;
  let stored = false;
  try {
    const thumb = await createThumbnailFile({
      sourcePath,
      width: source.width,
      height: source.height,
      signal: opts?.signal,
      scale: opts?.scaleImage,
    });
    if (!thumb) return order;
    localPath = thumb.path;
    const data = readFileSync(thumb.path);
    objectKey = keys.output(task.user_id, task.id, `${order}-thumbnail.jpg`);
    await putObjectFromPath(objectKey, thumb.path);
    rows.push({
      id: randomUUID(),
      task_id: task.id,
      kind: 'thumbnail',
      object_key: objectKey,
      mime: 'image/jpeg',
      width: thumb.width,
      height: thumb.height,
      duration: null,
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      watermarked: source.watermarked,
      sort_order: order,
    });
    stored = true;
    return order + 1;
  } catch (err) {
    if (objectKey && !stored) await removeObject(objectKey).catch(() => undefined);
    if (!opts?.signal?.aborted) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(JSON.stringify({ msg: 'thumbnail skipped', ...workerTaskFields(task), error: message.slice(0, 300) }));
    }
    return order;
  } finally {
    if (localPath) rmSync(localPath, { force: true });
  }
}

export async function setProgress(taskId: string, pct: number): Promise<void> {
  const clamped = Math.max(1, Math.min(99, Math.round(pct)));
  await exec("UPDATE generation_tasks SET progress = ?, heartbeat_at = NOW() WHERE id = ? AND status = 'running'", [
    clamped,
    taskId,
  ]);
}

async function rollbackUnstoredOutputs(
  rows: OutputRow[],
  files: ReadonlyArray<{ path: string } | null | undefined>,
  writablePaths: ReadonlyMap<number, string>,
): Promise<void> {
  await Promise.allSettled(rows.map((row) => removeObject(row.object_key)));
  for (let index = 0; index < files.length; index++) {
    const pending = files[index];
    if (!pending) continue;
    const writable = writablePaths.get(index);
    if (writable) {
      rmSync(writable, { force: true });
      continue;
    }
    if (!isInsideUploadRoot(pending.path)) rmSync(pending.path, { force: true });
  }
}

export async function persistOutputs(
  task: TaskRow,
  files: Awaited<ReturnType<ReturnType<typeof providerFor>['run']>>['outputs'],
  opts?: {
    remote?: boolean;
    signal?: AbortSignal;
    scaleImage?: ThumbnailScaler;
    /** Test injection. Omit to read C2PA_CERT_PEM and C2PA_KEY_PEM. */
    c2paCredentials?: C2paCredentials | null;
    /** Test injection. Production signs with @contentauth/c2pa-node. */
    signContentCredential?: C2paSigner;
  },
) {
  const rows: OutputRow[] = [];
  let posterKey: string | null = null;
  let primaryKey: string | null = null;
  const remote = opts?.remote ?? true;
  const plan = await planForUser(task.user_id);
  const watermarkRequired = planWatermarkRequired(plan.features);
  const c2pa =
    opts != null && Object.prototype.hasOwnProperty.call(opts, 'c2paCredentials')
      ? configuredC2paCredentials(opts.c2paCredentials?.certificatePem, opts.c2paCredentials?.privateKeyPem)
      : configuredC2paCredentials();

  let order = 0;
  const writablePaths = new Map<number, string>();
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    if (!file) continue;
    // Free plans need an implicit AIGC label before the object is stored.
    // Paid plans keep the provider bytes and record watermarked = 0. Built-in
    // frames already paint "AI GENERATED"; labeling only attaches metadata.
    // A path inside the upload root, including a symlink to one, is copied
    // first. Copy failures are not swallowed when the plan skips watermarks.
    let sourcePath: string;
    try {
      sourcePath = isolateUploadedOutput(file.path);
    } catch (err) {
      await rollbackUnstoredOutputs(rows, files, writablePaths);
      throw err;
    }
    writablePaths.set(index, sourcePath);

    let watermarked: 0 | 1 = 0;
    try {
      const labeled = await applyAigcLabel({
        path: sourcePath,
        mime: file.mime,
        watermarkRequired,
        remote,
      });
      watermarked = labeled.watermarked;
      if (watermarkRequired && watermarked !== 1) {
        throw new AigcLabelError('AIGC 标识写入失败');
      }
      await maybeSignOutput({
        path: sourcePath,
        mime: file.mime,
        kind: file.kind,
        watermarkRequired,
        credentials: c2pa,
        sign: opts?.signContentCredential,
      });
    } catch (err) {
      if (watermarkRequired) {
        const current = await queryOne<{ status: string }>(
          'SELECT status FROM generation_tasks WHERE id = ? LIMIT 1',
          [task.id],
        );
        await rollbackUnstoredOutputs(rows, files, writablePaths);
        // Cancellation already left `running`. A label error must not become a
        // later RENDER_ERROR that the caller records over the cancelled task.
        if (current && current.status !== 'running') return { rows, persisted: false };
        throw err;
      }
      watermarked = 0;
    }

    const ext = outputExtension(file.mime, file.kind);
    const objectKey = keys.output(task.user_id, task.id, `${order}-${file.kind}.${ext}`);
    const data = readFileSync(sourcePath);
    await putObjectFromPath(objectKey, sourcePath);

    const row: OutputRow = {
      id: randomUUID(),
      task_id: task.id,
      kind: file.kind,
      object_key: objectKey,
      mime: storedMime(file.mime, 80) ?? 'application/octet-stream',
      width: file.width,
      height: file.height,
      duration: file.duration,
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      watermarked,
      sort_order: order,
    };
    rows.push(row);
    if (file.kind === 'video' || (file.kind === 'image' && !primaryKey)) primaryKey = objectKey;
    if (file.kind === 'poster') posterKey = objectKey;
    order++;
    // Sidebar stills are best-effort and never replace the main object or its URLs.
    if ((file.kind === 'image' || file.kind === 'poster') && !opts?.signal?.aborted) {
      order = await attachThumbnail(task, sourcePath, row, order, rows, opts);
    }
    rmSync(sourcePath, { force: true });
  }

  const persisted = await withTransaction(async (conn) => {
    const [taskRows] = await conn.query<any[]>('SELECT status FROM generation_tasks WHERE id = ? FOR UPDATE', [
      task.id,
    ]);
    if (taskRows[0]?.status !== 'running') return false;
    await conn.query('DELETE FROM task_outputs WHERE task_id = ?', [task.id]);
    for (const row of rows) {
      await conn.query(
        `INSERT INTO task_outputs
          (id, task_id, kind, object_key, mime, width, height, duration, bytes, sha256, watermarked, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.task_id,
          row.kind,
          row.object_key,
          row.mime,
          row.width,
          row.height,
          row.duration,
          row.bytes,
          row.sha256,
          row.watermarked,
          row.sort_order,
        ],
      );
    }
    await conn.query(
      `UPDATE generation_tasks
          SET status = 'done', progress = 100, finished_at = NOW(), heartbeat_at = NOW(),
              result_url = ?, poster_url = ?, error = NULL, error_code = NULL
        WHERE id = ? AND status = 'running'`,
      [primaryKey, posterKey, task.id],
    );
    return true;
  });

  if (!persisted) {
    await Promise.allSettled(rows.map((row) => removeObject(row.object_key)));
  }
  return { rows, persisted };
}

/** Refunds the task's credits exactly once (guarded by `refunded_at`). */
export async function refundTask(taskId: string, reason: string): Promise<boolean> {
  const task = await loadTask(taskId);
  if (!task) return false;
  if (task.refunded_at) return false;
  if (task.credits_cost <= 0) {
    await exec('UPDATE generation_tasks SET refunded_at = NOW() WHERE id = ? AND refunded_at IS NULL', [taskId]);
    return false;
  }

  const refunded = await withTransaction(async (conn) => {
    const [rows] = await conn.query<any[]>('SELECT refunded_at FROM generation_tasks WHERE id = ? FOR UPDATE', [
      taskId,
    ]);
    if (!rows[0] || rows[0].refunded_at) return false;
    await adjustCredits(conn, task.user_id, task.credits_cost, creditReason('生成失败退款 · ', task.model_name), taskId);
    await conn.query('UPDATE generation_tasks SET refunded_at = NOW() WHERE id = ?', [taskId]);
    return true;
  });

  if (refunded) {
    await audit({
      userId: task.user_id,
      orgId: task.org_id,
      action: 'task.refund',
      target: taskId,
      meta: { amount: task.credits_cost, reason },
    });
  }
  return refunded;
}

export async function failTask(taskId: string, message: string, code = 'PROVIDER_ERROR'): Promise<void> {
  await exec(
    `UPDATE generation_tasks
        SET status = 'failed', error = ?, error_code = ?, finished_at = NOW(), heartbeat_at = NOW()
      WHERE id = ? AND status IN ('queued','running')`,
    [message.slice(0, 500), code, taskId],
  );
}

/**
 * Stamps `suspended_at` once and revokes refresh tokens with the same statement
 * account closure uses. A second hit does not move the original timestamp.
 * The user row, credits, orders and ledger stay. Audit meta is only the stage
 * and the severe category — never the prompt or the matched term.
 */
export async function suspendAccountForSevereContent(userId: string, stage: 'input' | 'output'): Promise<void> {
  const stampedAt = formatMysqlDateTime(new Date());
  await withTransaction(async (conn) => {
    await conn.query('UPDATE users SET suspended_at = ? WHERE id = ? AND suspended_at IS NULL', [
      stampedAt,
      userId,
    ]);
    await conn.query(REVOKE_SESSIONS_SQL, [stampedAt, userId]);
    try {
      await conn.query('UPDATE users SET tokens_valid_after = UTC_TIMESTAMP(3) WHERE id = ?', [userId]);
    } catch (err) {
      const code = String((err as { code?: string })?.code ?? '');
      const message = String((err as { message?: string })?.message ?? '');
      if (code !== 'ER_BAD_FIELD_ERROR' && !message.includes('tokens_valid_after')) throw err;
    }
  });
  await audit({
    userId,
    action: 'auth.account_suspend',
    target: userId,
    meta: { stage, category: 'severe' },
  });
}

type ResolvedProvider = ReturnType<typeof providerFor>;

function asRoute(model: StoredModel, resolved: ResolvedProvider, circuitOpen: boolean) {
  return toRoutingCandidate(model, { remote: resolved.remote, circuitOpen });
}

/**
 * Swap a tripped remote model for its configured standby before any provider
 * call. The standby must already have passed `selectFallback`, including
 * `remote === true`, so this never invokes builtin. `credits_cost` is left
 * on the original quote.
 */
async function adoptOpenCircuitFallback(
  task: TaskRow,
  model: StoredModel,
  provider: ResolvedProvider,
): Promise<{ model: StoredModel; provider: ResolvedProvider } | null> {
  const fallbackId = model.fallbackModelId?.trim() ?? '';
  if (!fallbackId || fallbackId === model.id) return null;
  const fallback = await getModel(fallbackId);
  if (!fallback) return null;
  const fallbackProvider = providerFor(fallback);
  const chosen = selectFallback(
    asRoute(model, provider, true),
    asRoute(fallback, fallbackProvider, isProviderCircuitOpen(fallbackProvider.id)),
  );
  if (!chosen || fallbackProvider.remote !== true) return null;
  const updated = await exec(
    'UPDATE generation_tasks SET model_id = ?, model_name = ? WHERE id = ?',
    [fallback.id, fallback.name, task.id],
  );
  if (updated.affectedRows !== 1) return null;
  return { model: fallback, provider: fallbackProvider };
}

type RunDeps = {
  onProgress: (pct: number) => Promise<void>;
  onHeartbeat: () => Promise<void>;
  isCancelled: () => Promise<boolean>;
};

/**
 * Full task lifecycle: resolve model → provider → render → store → outputs row.
 * Caller is responsible for the CAS claim and for queue ack/retry semantics.
 */
export async function executeTask(
  taskId: string,
  deps?: Partial<RunDeps>,
): Promise<{ ok: boolean; error?: string; code?: string; retryable?: boolean }> {
  const task = await loadTask(taskId);
  if (!task) return { ok: false, error: '任务不存在', code: 'NOT_FOUND' };
  if (task.status === 'done') return { ok: true };

  let model = await getModel(task.model_id);
  if (!model || model.enabled === false) {
    await failTask(taskId, '模型不存在或已下线', 'MODEL_UNAVAILABLE');
    await refundTask(taskId, '模型不可用');
    return { ok: false, error: 'MODEL_UNAVAILABLE', code: 'MODEL_UNAVAILABLE' };
  }

  const refs = await query<{ url: string }>(
    `SELECT a.url FROM generation_refs gr JOIN assets a ON a.id = gr.asset_id WHERE gr.task_id = ?`,
    [taskId],
  );

  let provider = providerFor(model);
  const onProgress = deps?.onProgress ?? ((pct: number) => setProgress(taskId, pct));
  const onHeartbeat = deps?.onHeartbeat ?? (() => heartbeat(taskId));
  const isCancelled =
    deps?.isCancelled ??
    (async () => {
      const current = await queryOne<Pick<TaskRow, 'status' | 'error_code'>>(
        'SELECT status, error_code FROM generation_tasks WHERE id = ? LIMIT 1',
        [taskId],
      );
      return current?.status === 'failed' && current.error_code === 'CANCELLED';
    });
  const controller = new AbortController();
  let checkingCancellation = false;
  const checkCancellation = async () => {
    if (controller.signal.aborted || checkingCancellation) return;
    checkingCancellation = true;
    try {
      if (await isCancelled()) controller.abort(new DOMException('任务已取消', 'AbortError'));
    } catch {
      // Heartbeats/retries already cover transient DB outages. A failed poll
      // must not turn a healthy render into a terminal task failure.
    } finally {
      checkingCancellation = false;
    }
  };

  // Progress writes are coalesced; heartbeats keep the reaper away meanwhile.
  const progressThrottle = createProgressThrottle((pct) => onProgress(pct));
  const progress = (pct: number) => progressThrottle.push(pct);

  const ticker = setInterval(() => {
    void onHeartbeat();
  }, 15_000);
  const cancellationTicker = setInterval(() => void checkCancellation(), 250);
  cancellationTicker.unref?.();
  let producedOutputs: Awaited<ReturnType<ReturnType<typeof providerFor>['run']>>['outputs'] = [];

  try {
    await checkCancellation();
    controller.signal.throwIfAborted();
    // Open remote breaker may move to a qualified remote standby. Builtin is
    // never that standby; an unqualified standby keeps the retryable busy error.
    const resumeJobId = recordedJobId(task.provider_job_id);
    // An accepted upstream job stays on that provider. Failover would submit elsewhere.
    if (!resumeJobId && circuitFailoverAllowed({ remote: provider.remote, circuitOpen: isProviderCircuitOpen(provider.id) })) {
      const switched = await adoptOpenCircuitFallback(task, model, provider);
      if (!switched) {
        throw new ProviderError('PROVIDER_BUSY', '上游连续失败，已暂时熔断', {
          retryable: true,
          refundable: true,
        });
      }
      model = switched.model;
      provider = switched.provider;
      task.model_id = model.id;
      task.model_name = model.name;
    }
    const frame = renderFrame(task.type, task.width, task.height);
    const result = await provider.run(
      {
        taskId,
        userId: task.user_id,
        type: task.type,
        prompt: task.prompt,
        model,
        width: frame.width,
        height: frame.height,
        duration: renderDuration(task.type, task.duration),
        count: Number(task.count) || 1,
        seed: task.seed,
        refUrls: refs.map((r) => r.url),
        providerJobId: resumeJobId || null,
        traceId: task.trace_id,
      },
      {
        onProgress: progress,
        signal: controller.signal,
        onJobId: async (jobId) => {
          await exec('UPDATE generation_tasks SET provider_job_id = ? WHERE id = ?', [jobId, taskId]);
        },
      },
    );
    producedOutputs = result.outputs;
    await progressThrottle.flush();
    await checkCancellation();
    controller.signal.throwIfAborted();
    if (provider.remote) recordProviderSuccess(provider.id);

    const verdict = await moderateOutputs(
      result.outputs.map((o) => o.path),
      {
        remoteProvider: provider.remote,
      },
    );
    if (!verdict.ok) {
      result.outputs.forEach((o) => discardRenderTemp(o.path));
      await failTask(taskId, verdict.reason ?? '输出内容未通过审核', 'CONTENT_REJECTED');
      await refundTask(taskId, '输出审核未通过');
      await audit({
        userId: task.user_id,
        orgId: task.org_id,
        action: 'task.content_rejected',
        target: taskId,
        meta: contentRejectionAuditMeta({
          stage: 'output',
          prompt: task.prompt,
          unverified: Boolean(verdict.unverified),
          reason: verdict.reason?.slice(0, 200),
        }),
      });
      if (!verdict.unverified && reasonSuspendsAccount(verdict.reason)) {
        await suspendAccountForSevereContent(task.user_id, 'output');
      }
      return { ok: false, error: verdict.reason, code: 'CONTENT_REJECTED' };
    }

    const stored = await persistOutputs(task, result.outputs, {
      remote: provider.remote,
      signal: controller.signal,
    });
    if (!stored.persisted) {
      return { ok: false, error: '任务已取消或已由其他执行器终结', code: 'CANCELLED' };
    }
    const providerJobId = successJobIdUpdate(result.providerJobId);
    const costActual = storedCostActual(result.costActual);
    if (typeof providerJobId === 'string') {
      await exec('UPDATE generation_tasks SET provider_job_id = ?, cost_actual = ? WHERE id = ?', [
        providerJobId,
        costActual,
        taskId,
      ]);
    } else {
      await exec('UPDATE generation_tasks SET cost_actual = ? WHERE id = ?', [costActual, taskId]);
    }
    await audit({
      userId: task.user_id,
      orgId: task.org_id,
      action: 'task.complete',
      target: taskId,
      meta: { model: task.model_id, simulated: isSimulated(model), outputs: result.outputs.length },
    });
    return { ok: true };
  } catch (err) {
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      producedOutputs.forEach((output) => discardRenderTemp(output.path));
      return { ok: false, error: '任务已取消', code: 'CANCELLED', retryable: false };
    }
    if (provider.remote) recordProviderFailure(provider.id, err instanceof ProviderError ? err.code : '');
    const isProvider = err instanceof ProviderError;
    const message = err instanceof Error ? err.message : String(err);
    const code = isProvider ? err.code : 'RENDER_ERROR';
    const retryable = isProvider ? err.retryable : false;

    // Temporary upstream failures stay `running` for the retry path; terminal
    // ones fail immediately and refund.
    if (!retryable) {
      await failTask(taskId, message, code);
      const shouldRefund = !isProvider || err.refundable;
      if (shouldRefund) await refundTask(taskId, code);
    }
    await audit({
      userId: task.user_id,
      orgId: task.org_id,
      action: 'task.fail',
      target: taskId,
      meta: { code, message: message.slice(0, 300), retryable },
    });
    return { ok: false, error: message, code, retryable };
  } finally {
    progressThrottle.stop();
    clearInterval(ticker);
    clearInterval(cancellationTicker);
  }
}

/** Output rows → client DTO with freshly signed URLs. */
export function outputDtos(rows: OutputRow[]) {
  return rows.map((o) => ({
    id: o.id,
    kind: o.kind,
    url: signedUrl(o.object_key),
    mime: o.mime,
    width: o.width === null ? null : Number(o.width),
    height: o.height === null ? null : Number(o.height),
    duration: o.duration === null ? null : Number(o.duration),
    bytes: o.bytes === null ? null : Number(o.bytes),
    watermarked: Boolean(o.watermarked),
  }));
}

export async function loadOutputs(taskId: string): Promise<OutputRow[]> {
  return query<OutputRow>('SELECT * FROM task_outputs WHERE task_id = ? ORDER BY sort_order ASC', [taskId]);
}

/** A queued row handed back to the runner, with the priority taken from that row. */
export type RequeueTask = { id: string; priority: number };

export { storedQueuePriority };

/**
 * Zombie-task reaper. A stuck running task with an upstream job id and a
 * remaining attempt is queued again. Anything else fails and is refunded once.
 * Idempotent, so it is safe to run on every instance.
 */
export type ReapResult = { failed: number; resumeIds: RequeueTask[] };

export async function reapStaleTasks(): Promise<ReapResult> {
  const rows = await query<{
    id: string;
    provider_job_id: string | null;
    attempts: number;
    max_attempts: number;
    priority: unknown;
  }>(
    `SELECT id, provider_job_id, attempts, max_attempts, priority FROM generation_tasks
      WHERE status = 'running'
        AND COALESCE(heartbeat_at, started_at, updated_at) < NOW() - INTERVAL ? MINUTE`,
    [env.staleTaskMinutes],
  );
  const result: ReapResult = { failed: 0, resumeIds: [] };
  for (const row of rows) {
    if (staleRecovery(row) === 'resume') {
      const updated = await withNextAttemptColumn(
        () =>
          exec(
            "UPDATE generation_tasks SET status = 'queued', attempts = attempts + 1, next_attempt_at = NULL WHERE id = ? AND status = 'running'",
            [row.id],
          ),
        () =>
          exec(
            "UPDATE generation_tasks SET status = 'queued', attempts = attempts + 1 WHERE id = ? AND status = 'running'",
            [row.id],
          ),
      );
      if (updated.affectedRows === 1) {
        result.resumeIds.push({ id: row.id, priority: storedQueuePriority(row.priority) });
      }
      continue;
    }
    await failTask(row.id, '任务超时：渲染进程失联，已自动退款', 'PROVIDER_TIMEOUT');
    await refundTask(row.id, 'PROVIDER_TIMEOUT');
    result.failed += 1;
  }
  return result;
}

/**
 * Boot recovery. Anything left `queued` by a restart is handed back to the
 * queue runner instead of being silently marked done.
 */
export async function recoverOrphanTasks(): Promise<RequeueTask[]> {
  const rows = await withNextAttemptColumn(
    () =>
      query<{ id: string; priority: unknown }>(
        `SELECT id, priority FROM generation_tasks WHERE status = 'queued' AND ${queuedReadySql()} ORDER BY ${storedQueuePrioritySql} ASC, created_at ASC LIMIT 200`,
      ),
    () =>
      query<{ id: string; priority: unknown }>(
        `SELECT id, priority FROM generation_tasks WHERE status = 'queued' ORDER BY ${storedQueuePrioritySql} ASC, created_at ASC LIMIT 200`,
      ),
  );
  return rows.map((r) => ({ id: r.id, priority: storedQueuePriority(r.priority) }));
}

/** Zombie count for the `StaleRunningTasks` alert / Grafana stat panel. */
export async function staleRunningCount(): Promise<number> {
  try {
    const rows = await query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM generation_tasks
        WHERE status = 'running'
          AND COALESCE(heartbeat_at, started_at, updated_at) < NOW() - INTERVAL ? MINUTE`,
      [env.staleTaskMinutes],
    );
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Number of billing inconsistencies right now. This is the single most
 * important number on the dashboard: it must be 0, always.
 * Kept cheap (three indexed aggregates) because it runs on every scrape.
 */
export async function reconcileIssueCount(): Promise<number> {
  try {
    const drift = await query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM (
         SELECT u.id
           FROM users u LEFT JOIN credit_transactions t ON t.user_id = u.id
          GROUP BY u.id, u.credits
         HAVING u.credits <> COALESCE(SUM(t.delta), 0)
       ) x`,
    );
    const doubleCharged = await query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM (
         SELECT ref_id
           FROM credit_transactions
          WHERE delta < 0 AND ref_id IS NOT NULL AND reason LIKE '生成任务扣费%'
          GROUP BY ref_id HAVING COUNT(*) > 1
       ) x`,
    );
    const unrefunded = await query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM generation_tasks
        WHERE status = 'failed' AND credits_cost > 0 AND refunded_at IS NULL
          AND error_code <> 'CANCELLED'`,
    );
    return Number(drift[0]?.c ?? 0) + Number(doubleCharged[0]?.c ?? 0) + Number(unrefunded[0]?.c ?? 0);
  } catch {
    return 0;
  }
}
