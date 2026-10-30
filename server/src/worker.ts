/**
 * Dedicated worker entry point.
 *
 * Run this instead of (or alongside) the API's embedded runner when you want
 * render throughput to scale independently of request handling:
 *
 *   EMBEDDED_WORKER=false npm start     # API only
 *   npm run worker                      # workers, scaled by replica count
 *
 * Multiple replicas share the same consumer group, so each message is handled
 * exactly once even with N workers.
 */
import { env } from './env.js';
import { pool } from './db/pool.js';
import { QueueRunner, startReaper } from './services/runner.js';
import { recoverOrphanTasks } from './services/pipeline.js';
import { enqueue, closeRedis } from './services/queue.js';
import { startMonthlyCreditScheduler } from './services/monthlyCredits.js';
import { stopTelemetry } from './telemetry.js';
import { emitProcessLog } from './lib/process-log.js';
import { installConfiguredProviders } from './services/http-provider.js';

export async function startWorker() {
  installConfiguredProviders();
  emitProcessLog('info', `[worker] 启动 (pid=${process.pid}) 并发=${env.redis.concurrency}`, {
    msg: 'worker starting',
    pid: process.pid,
    concurrency: env.redis.concurrency,
  });
  const runner = new QueueRunner(env.redis.concurrency);
  await runner.start();
  const reaper = startReaper();
  const monthlyCredits = startMonthlyCreditScheduler(env.monthlyCreditIntervalMs);

  // Re-publish anything a crashed process left queued.
  const orphans = await recoverOrphanTasks();
  for (const task of orphans) await enqueue(task.id, task.priority);
  if (orphans.length) {
    emitProcessLog('info', `[worker] 重新入队 ${orphans.length} 个未完成任务`, {
      msg: 'worker requeued',
      count: orphans.length,
    });
  }

  // Graceful drain: stop taking new work, let in-flight renders finish.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    emitProcessLog('info', `[worker] 收到 ${signal}，等待当前任务完成后退出…`, {
      msg: 'worker shutting down',
      signal,
    });
    clearInterval(reaper);
    clearInterval(monthlyCredits);
    await runner.stop();
    await closeRedis();
    await pool.end().catch(() => {});
    await stopTelemetry();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  emitProcessLog('info', '[worker] 就绪，等待任务…', { msg: 'worker ready' });
}

