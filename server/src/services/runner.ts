import { randomUUID } from 'node:crypto';
import { env } from '../env.js';
import { exec, query, queryOne } from '../db/pool.js';
import {
  ack,
  claimStale,
  enqueue,
  queueDepth,
  readGroup,
  redisAvailable,
  trimStream,
} from './queue.js';
import { claimTask, executeTask, failTask, loadTask, refundTask, reapStaleTasks } from './pipeline.js';
import { storedQueuePriority, storedQueuePrioritySql } from './queue-lane.js';
import { emitProcessLog, oneLineDetail } from '../lib/process-log.js';
import { workerTaskFields } from '../lib/worker-log.js';

import { incCounter, observeHistogram } from '../lib/metrics.js';
import { nextAttemptAt, queuedReadySql, retryDelayMs, withNextAttemptColumn } from './retry-schedule.js';

const consumerName = () => `${process.env.WORKER_NAME ?? 'worker'}-${process.pid}-${randomUUID().slice(0, 6)}`;

/**
 * Runs one queue message end-to-end.
 *
 * Retry policy: a retryable provider error is re-enqueued with exponential
 * backoff until `max_attempts`; anything else fails immediately and refunds.
 */
export async function processMessage(
  taskId: string,
  opts: { ackEntryId?: string; ackStream?: string } = {},
): Promise<void> {
  const finish = () => {
    if (!opts.ackEntryId) return Promise.resolve();
    return opts.ackStream ? ack(opts.ackEntryId, opts.ackStream) : ack(opts.ackEntryId);
  };
  const task = await loadTask(taskId);
  if (!task) {
    await finish();
    return;
  }
  // Already finished (duplicate delivery). A failed task whose refund was
  // interrupted keeps the message pending until the idempotent refund lands.
  if (task.status === 'failed') {
    if (!task.refunded_at && Number(task.credits_cost) > 0 && task.error_code !== 'CANCELLED') {
      await refundTask(taskId, task.error_code ?? 'FAILED_TASK_RECOVERY');
    }
    await finish();
    return;
  }
  if (task.status === 'done') {
    await finish();
    return;
  }

  const won = await claimTask(taskId);
  if (!won) {
    // Another worker owns it, or it left `queued` for another reason.
    await finish();
    return;
  }

  const startedAt = Date.now();
  const result = await executeTask(taskId);
  console.log(JSON.stringify({ msg: 'worker task', outcome: result.ok ? 'ok' : 'fail', ...workerTaskFields(task) }));

  observeHistogram(
    'benchu_task_duration_ms',
    'Task execution time (ms)',
    Date.now() - startedAt,
    { type: task.type, model: task.model_id, outcome: result.ok ? 'ok' : 'fail' },
  );
  incCounter('benchu_tasks_total', 'Tasks processed', 1, {
    outcome: result.ok ? 'ok' : 'fail',
    model: task.model_id,
  });
  if (result.code === 'PROVIDER_AUTH') {
    incCounter('benchu_provider_auth_total', 'Upstream credential rejections', 1, {
      model: String(task.model_id || 'unknown').slice(0, 64),
    });
  }

  if (result.ok) {
    await finish();
    return;
  }

  if (result.retryable) {
    const attempts = Number(task.attempts) + 1;
    if (attempts < Number(task.max_attempts)) {
      const when = nextAttemptAt(attempts);
      await withNextAttemptColumn(
        () =>
          exec(
            "UPDATE generation_tasks SET attempts = ?, status = 'queued', next_attempt_at = ? WHERE id = ? AND status = 'running'",
            [attempts, when, taskId],
          ),
        () =>
          exec("UPDATE generation_tasks SET attempts = ?, status = 'queued' WHERE id = ? AND status = 'running'", [
            attempts,
            taskId,
          ]),
      );
      // The durable timestamp is the recovery source of truth. ACK only after
      // it is stored, then republish once the delay elapses. A restart's
      // reconciler skips the row until next_attempt_at.
      await finish();
      const delayMs = retryDelayMs(attempts);
      setTimeout(() => {
        void enqueue(taskId, storedQueuePriority(task.priority));
      }, delayMs).unref?.();
      return;
    }
    await exec("UPDATE generation_tasks SET attempts = ? WHERE id = ? AND status = 'running'", [attempts, taskId]);
    incCounter('benchu_tasks_dead_letter_total', 'Tasks that exhausted retries', 1, {
      model: String(task.model_id || 'unknown').slice(0, 64),
    });
    await failTask(taskId, result.error ?? '渲染失败，已达最大重试次数', result.code);
    await refundTask(taskId, result.code ?? 'PROVIDER_ERROR');
  }
  // Non-retryable executeTask paths commit their terminal state/refund before
  // returning. Keeping ACK last prevents an acknowledged-but-running gap.
  await finish();
}

/**
 * Consumer loop for a dedicated worker process (or the API's embedded runner).
 * Blocks on the stream; falls back to DB polling when Redis is unavailable so a
 * single-node dev machine without Redis still processes tasks.
 */
export class QueueRunner {
  private stopping = false;
  private readonly consumer = consumerName();
  private loops: Promise<void>[] = [];
  private idleTimers: NodeJS.Timeout[] = [];
  private inFlight = new Set<Promise<void>>();
  private usesRedis = false;
  private lastQueuedReconcileAt = 0;

  constructor(private readonly concurrency = env.redis.concurrency) {}

  async start() {
    this.usesRedis = redisAvailable();
    if (this.usesRedis) {
      for (let i = 0; i < this.concurrency; i++) {
        this.loops.push(this.redisLoop(i));
      }
      emitProcessLog('info', `[worker] 已启动 ${this.concurrency} 个 Redis Streams 消费者 (${this.consumer})`, {
        msg: 'worker consumers',
        concurrency: this.concurrency,
        consumer: this.consumer,
      });
      // Recover entries left in the PEL by a worker that died mid-task.
      const reclaimed = await claimStale(60_000).catch(() => []);
      for (const msg of reclaimed) {
        this.processInBackground(msg);
      }
      // Acknowledged entries are retained; trim them opportunistically.
      void trimStream().catch(() => {});
      if (reclaimed.length) {
        emitProcessLog('info', `[worker] 认领遗留任务 ${reclaimed.length} 个`, {
          msg: 'worker reclaimed',
          count: reclaimed.length,
        });
      }
    } else {
      this.loops.push(this.dbPollLoop());
      emitProcessLog('info', '[worker] 使用 DB 轮询模式（Redis 不可用）', { msg: 'worker db polling' });
    }
  }

  private async redisLoop(slot: number) {
    while (!this.stopping) {
      try {
        const msgs = await readGroup(this.consumer, 1, 2000);
        if (msgs.length === 0) {
          // Nothing to do — occasionally sweep the PEL for abandoned entries
          // and trim acknowledged ones so the stream does not grow forever.
          if (slot === 0) {
            const stale = await claimStale(120_000, 5).catch(() => []);
            for (const msg of stale) {
              this.processInBackground(msg);
            }
            void trimStream().catch(() => {});
            await this.republishQueuedTasks();
          }
          continue;
        }
        for (const msg of msgs) {
          await processMessage(msg.taskId, { ackEntryId: msg.entryId, ackStream: msg.stream });
        }
      } catch (err) {
        if (this.stopping) return;
        emitProcessLog('warn', `[worker] Redis 读取失败，切换到 DB 轮询: ${oneLineDetail(err)}`, {
          msg: 'worker redis read failed',
          error: oneLineDetail(err),
        });
        this.usesRedis = false;
        this.loops.push(this.dbPollLoop());
        return;
      }
    }
  }

  /** Repairs the DB-written / Redis-XADD-failed window while Redis is healthy. */
  private async republishQueuedTasks() {
    if (Date.now() - this.lastQueuedReconcileAt < 10_000) return;
    this.lastQueuedReconcileAt = Date.now();
    const queued = await withNextAttemptColumn(
      () =>
        query<{ id: string; priority: unknown }>(
          `SELECT id, priority FROM generation_tasks WHERE status = 'queued' AND ${queuedReadySql()} ORDER BY ${storedQueuePrioritySql} ASC, created_at ASC LIMIT 50`,
        ),
      () =>
        query<{ id: string; priority: unknown }>(
          `SELECT id, priority FROM generation_tasks WHERE status = 'queued' ORDER BY ${storedQueuePrioritySql} ASC, created_at ASC LIMIT 50`,
        ),
    );
    for (const task of queued) await enqueue(task.id, storedQueuePriority(task.priority));
  }

  private async dbPollLoop() {
    while (!this.stopping) {
      try {
        const task = await withNextAttemptColumn(
          () =>
            queryOne<{ id: string }>(
              `SELECT id FROM generation_tasks WHERE status = 'queued' AND ${queuedReadySql()} ORDER BY ${storedQueuePrioritySql} ASC, created_at ASC LIMIT 1`,
            ),
          () =>
            queryOne<{ id: string }>(
              `SELECT id FROM generation_tasks WHERE status = 'queued' ORDER BY ${storedQueuePrioritySql} ASC, created_at ASC LIMIT 1`,
            ),
        );
        if (task) {
          await processMessage(task.id);
          continue;
        }
      } catch (err) {
        emitProcessLog('warn', `[worker] DB 轮询失败: ${oneLineDetail(err)}`, {
          msg: 'worker db poll failed',
          error: oneLineDetail(err),
        });
      }
      await sleep(1200);
    }
  }

  private processInBackground(msg: { taskId: string; entryId: string; stream?: string }) {
    if (this.stopping) return;
    const pending = processMessage(msg.taskId, { ackEntryId: msg.entryId, ackStream: msg.stream })
      .catch((err) =>
        emitProcessLog('warn', `[worker] 遗留任务处理失败: ${oneLineDetail(err)}`, {
          msg: 'worker reclaim failed',
          error: oneLineDetail(err),
        }),
      )
      .finally(() => this.inFlight.delete(pending));
    this.inFlight.add(pending);
  }

  async stop() {
    this.stopping = true;
    this.idleTimers.forEach(clearTimeout);
    await Promise.allSettled(this.loops);
    // Reclaimed PEL entries run outside the consumer loops. Keep DB/Redis open
    // until every such task has committed and acknowledged its final state.
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
    emitProcessLog('info', '[worker] 已优雅退出', { msg: 'worker stopped' });
  }

  get mode() {
    return this.usesRedis ? 'redis-streams' : 'db-poll';
  }

  async depth() {
    return queueDepth();
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Periodically fails zombie `running` tasks and refunds them. Runs inside both
 * the API and the worker; the DB guard makes concurrent runs harmless.
 */
export function startReaper(onReaped?: (n: number) => void): NodeJS.Timeout {
  const timer = setInterval(() => {
    void reapStaleTasks()
      .then(async (result) => {
        for (const task of result.resumeIds) await enqueue(task.id, task.priority);
        if (result.resumeIds.length > 0) {
          emitProcessLog('info', `[reaper] 按上游任务号续跑 ${result.resumeIds.length} 个`, {
            msg: 'reaper resume',
            count: result.resumeIds.length,
          });
        }
        if (result.failed > 0) {
          emitProcessLog('info', `[reaper] 清理僵尸任务 ${result.failed} 个并已退款`, {
            msg: 'reaper refund',
            count: result.failed,
          });
          onReaped?.(result.failed);
        }
      })
      .catch((err) =>
        emitProcessLog('warn', `[reaper] 扫描失败: ${oneLineDetail(err)}`, {
          msg: 'reaper failed',
          error: oneLineDetail(err),
        }),
      );
  }, env.reaperIntervalMs);
  timer.unref?.();
  return timer;
}
