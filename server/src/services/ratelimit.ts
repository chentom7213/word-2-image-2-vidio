import { getRedis, redisAvailable } from './queue.js';
import { tooMany } from '../lib/errors.js';
import { needsRateLimitExpire } from '../lib/rate-limit-expire.js';
import { memoryRateAllows, type MemoryBucket } from '../lib/rate-limit-memory.js';

/**
 * Fixed window from the first hit, backed by Redis INCR + EXPIRE.
 * In-memory fallback uses the same window when Redis is down.
 */

const mem = new Map<string, MemoryBucket>();

function memCheck(key: string, limit: number, windowSec: number): boolean {
  return memoryRateAllows(mem, key, limit, windowSec, Date.now());
}

/** Returns true if the event is allowed (under limit). Throws 429 otherwise. */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSec: number,
  label = '操作过于频繁',
): Promise<boolean> {
  if (limit <= 0) return true;
  if (!redisAvailable()) {
    if (!memCheck(key, limit, windowSec)) throw tooMany(label);
    return true;
  }

  const r = getRedis();
  const redisKey = `rl:${key}`;
  try {
    const count = await r.incr(redisKey);
    if (count === 1) {
      await r.expire(redisKey, windowSec);
    } else if (count > 1) {
      const ttlSeconds = await r.ttl(redisKey);
      if (needsRateLimitExpire(count, ttlSeconds)) await r.expire(redisKey, windowSec);
    }
    if (count > limit) throw tooMany(label);
    return true;
  } catch (err) {
    if (err instanceof Error && 'statusCode' in (err as any)) throw err;
    if (!memCheck(key, limit, windowSec)) throw tooMany(label);
    return true;
  }
}

/** Clears the counter for a key (used on successful login). */
export async function resetRateLimit(key: string): Promise<void> {
  if (!redisAvailable()) {
    mem.delete(key);
    return;
  }
  try {
    await getRedis().del(`rl:${key}`);
  } catch {
    /* ignore */
  }
}
