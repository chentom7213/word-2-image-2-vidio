import Redis from 'ioredis';
import { env } from '../env.js';
import { query } from '../db/pool.js';
import { emitProcessLog, oneLineDetail } from '../lib/process-log.js';
import { laneForPriority, laneStreamKeys, storedQueuePriority, streamForLane } from './queue-lane.js';

/**
 * Redis Streams queue.
 *
 * The DB is the source of truth for task state; Redis only carries the
 * "who should work on this next" signal. That split means losing Redis costs
 * throughput (the sweeper re-enqueues orphans) but never task data.
 */
let client: Redis | null = null;
let subscriber: Redis | null = null;
let unhealthy = false;

export function redisAvailable(): boolean {
  return env.redis.enabled && !unhealthy;
}

function build(): Redis {
  return new Redis({
    host: env.redis.host,
    port: env.redis.port,
    password: env.redis.password,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    lazyConnect: false,
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2000)),
  });
}

export function getRedis(): Redis {
  if (!client) {
    client = build();
    client.on('error', (err) => {
      if (!unhealthy) {
        unhealthy = true;
        emitProcessLog('warn', `[queue] Redis 不可用，回退到进程内执行: ${oneLineDetail(err)}`, {
          msg: 'queue redis down',
          error: oneLineDetail(err),
        });
      }
    });
    client.on('ready', () => {
      if (unhealthy) emitProcessLog('info', '[queue] Redis 已恢复', { msg: 'queue redis recovered' });
      unhealthy = false;
    });
  }
  return client;
}

/** Consumer connections cannot share the main client once they start blocking. */
export function getConsumerRedis(): Redis {
  if (!subscriber) {
    subscriber = build();
    subscriber.on('error', () => {
      /* handled by the shared health flag on the primary client */
    });
  }
  return subscriber;
}

export const streamKey = () => env.redis.stream;
export const groupName = () => env.redis.group;

let groupReady = false;

export async function ensureGroup(): Promise<void> {
  if (groupReady) return;
  const r = getRedis();
  for (const key of laneStreamKeys(streamKey())) {
    try {
      await r.xgroup('CREATE', key, groupName(), '$', 'MKSTREAM');
    } catch (err: any) {
      // BUSYGROUP → already created by another process, which is fine.
      if (!String(err?.message ?? '').includes('BUSYGROUP')) throw err;
    }
  }
  groupReady = true;
}

export type QueueMessage = { taskId: string; priority: number };

export async function enqueue(taskId: string, priority = 5): Promise<boolean> {
  const stored = storedQueuePriority(priority);
  if (!redisAvailable()) return false;
  try {
    await ensureGroup();
    const lane = laneForPriority(stored);
    await getRedis().xadd(
      streamForLane(streamKey(), lane),
      '*',
      'taskId',
      taskId,
      'priority',
      String(stored),
    );
    return true;
  } catch {
    return false;
  }
}

export type ClaimedMessage = { entryId: string; taskId: string; priority: number; stream: string };

function messagesFrom(stream: string, res: Array<[string, Array<[string, string[]]>]> | null): ClaimedMessage[] {
  if (!res) return [];
  const out: ClaimedMessage[] = [];
  for (const [, entries] of res) {
    for (const [entryId, flat] of entries) {
      const map = new Map<string, string>();
      for (let i = 0; i + 1 < flat.length; i += 2) map.set(flat[i], flat[i + 1]);
      const taskId = map.get('taskId');
      if (taskId) out.push({ entryId, taskId, stream, priority: storedQueuePriority(map.get('priority')) });
    }
  }
  return out;
}

async function readLane(stream: string, consumer: string, count: number, blockMs: number): Promise<ClaimedMessage[]> {
  const r = getConsumerRedis();
  const args: (string | number)[] = ['GROUP', groupName(), consumer, 'COUNT', count];
  if (blockMs > 0) args.push('BLOCK', blockMs);
  args.push('STREAMS', stream, '>');
  const res = (await (r as any).xreadgroup(...args)) as Array<[string, Array<[string, string[]]>]> | null;
  return messagesFrom(stream, res);
}

export async function readGroup(
  consumer: string,
  count: number,
  blockMs: number,
): Promise<ClaimedMessage[]> {
  await ensureGroup();
  const [high, normal, low] = laneStreamKeys(streamKey());
  const urgent = await readLane(high, consumer, count, 0);
  if (urgent.length) return urgent;
  const ready = await readLane(normal, consumer, count, 0);
  if (ready.length) return ready;
  if (blockMs <= 0) return readLane(low, consumer, count, 0);
  // Block on the high lane so an enterprise task is not stuck behind the low-lane wait.
  const waited = await readLane(high, consumer, count, blockMs);
  if (waited.length) return waited;
  const afterWait = await readLane(normal, consumer, count, 0);
  if (afterWait.length) return afterWait;
  return readLane(low, consumer, count, 0);
}

/**
 * Re-delivers entries a dead worker claimed but never acked.
 * XPENDING + XCLAIM is used instead of XAUTOCLAIM because the latter needs
 * Redis 6.2+, and this runs against Redis 5 in development.
 */
export async function claimStale(idleMs: number, count = 20): Promise<ClaimedMessage[]> {
  if (!redisAvailable()) return [];
  await ensureGroup();
  const r = getConsumerRedis();
  const out: ClaimedMessage[] = [];
  for (const stream of laneStreamKeys(streamKey())) {
    const pending = (await r.xpending(stream, groupName(), 'IDLE', idleMs, '-', '+', count)) as unknown as Array<
      [string, string, number, number]
    >;
    for (const row of pending ?? []) {
      const entryId = row[0];
      const claimed = (await r.xclaim(stream, groupName(), 'reaper', 0, entryId, 'TIME', idleMs)) as unknown as Array<
        [string, string[]]
      >;
      for (const [id, flat] of claimed ?? []) {
        const map = new Map<string, string>();
        for (let i = 0; i + 1 < flat.length; i += 2) map.set(flat[i], flat[i + 1]);
        const taskId = map.get('taskId');
        if (taskId) out.push({ entryId: id, taskId, stream, priority: storedQueuePriority(map.get('priority')) });
      }
    }
  }
  return out;
}

export async function ack(entryId: string, stream?: string): Promise<void> {
  try {
    await getRedis().xack(stream || streamKey(), groupName(), entryId);
  } catch {
    /* an un-acked entry is retried by claimStale, so this is not fatal */
  }
}

/**
 * Real backlog = undelivered entries (`XINFO GROUPS.lag`) + delivered but
 * unacked entries (`XPENDING`).
 *
 * `XLEN` is wrong here: the stream retains acknowledged entries, so XLEN only
 * ever grows and an alert on it fires forever. The stream is trimmed
 * opportunistically in `trimStream` to keep memory flat.
 */
export async function queueDepth(): Promise<number> {
  if (!redisAvailable()) {
    try {
      const rows = await query<{ c: number }>(
        "SELECT COUNT(*) AS c FROM generation_tasks WHERE status = 'queued'",
      );
      return Number(rows[0]?.c ?? 0);
    } catch {
      return 0;
    }
  }
  try {
    const r = getRedis();
    let depth = 0;
    for (const stream of laneStreamKeys(streamKey())) {
      try {
        const groups = (await r.xinfo('GROUPS', stream)) as unknown as any[];
        let lag = 0;
        for (const g of groups ?? []) {
          // ioredis returns a flat [key, value, key, value] array.
          const flat = Array.isArray(g) ? g : [];
          for (let i = 0; i + 1 < flat.length; i += 2) {
            if (String(flat[i]) === 'lag' && flat[i + 1] !== null) lag += Number(flat[i + 1]) || 0;
          }
        }
        const pending = (await r.xpending(stream, groupName())) as unknown as any[];
        depth += lag + Number(pending?.[0] ?? 0);
      } catch {
        /* a lane that has not been created yet is empty */
      }
    }
    return depth;
  } catch {
    return 0;
  }
}

/** Keeps the stream from growing without bound now that entries are acked. */
export async function trimStream(maxLen = 10_000): Promise<void> {
  if (!redisAvailable()) return;
  for (const stream of laneStreamKeys(streamKey())) {
    try {
      await getRedis().xtrim(stream, 'MAXLEN', '~', maxLen);
    } catch {
      /* trimming is best-effort */
    }
  }
}

export async function closeRedis(): Promise<void> {
  try {
    await client?.quit();
  } catch {
    /* ignore */
  }
  try {
    await subscriber?.quit();
  } catch {
    /* ignore */
  }
  client = null;
  subscriber = null;
}
