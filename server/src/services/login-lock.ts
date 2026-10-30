import { needsLoginFailureExpire } from '../lib/login-lock-expire.js';
import { getRedis, redisAvailable } from './queue.js';
import { resetRateLimit } from './ratelimit.js';

const LOCK_AFTER = 10;
const LOCK_SEC = 15 * 60;
const LOCK_MS = LOCK_SEC * 1000;

type Attempt = { count: number; first: number; lockedUntil: number };
const attempts = new Map<string, Attempt>();

function lockId(ip: string): string {
  const cleaned = ip.replace(/[\u0000-\u001f\s]/g, '').slice(0, 64);
  return cleaned || 'unknown';
}

function rememberFailure(ip: string) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > LOCK_MS) {
    attempts.set(ip, { count: 1, first: now, lockedUntil: 0 });
    return;
  }
  rec.count += 1;
  if (rec.count >= LOCK_AFTER) rec.lockedUntil = now + LOCK_MS;
}

/** Counts a failed login. Ten failures inside 15 minutes lock the address. */
export async function noteLoginFailure(ip: string): Promise<void> {
  const id = lockId(ip);
  rememberFailure(id);
  if (!redisAvailable()) return;
  try {
    const redis = getRedis();
    const key = `loginfail:${id}`;
    const fails = await redis.incr(key);
    if (fails === 1) {
      await redis.expire(key, LOCK_SEC);
    } else if (fails > 1 && typeof redis.ttl === 'function') {
      const ttlSeconds = await redis.ttl(key);
      if (needsLoginFailureExpire(fails, ttlSeconds)) await redis.expire(key, LOCK_SEC);
    }
    if (fails >= LOCK_AFTER) await redis.set(`loginlock:${id}`, '1', 'EX', LOCK_SEC);
  } catch {
    /* This process already kept the count. */
  }
}

function processLocked(id: string): boolean {
  const rec = attempts.get(id);
  return Boolean(rec?.lockedUntil && rec.lockedUntil > Date.now());
}

export async function loginLocked(ip: string): Promise<boolean> {
  const id = lockId(ip);
  if (redisAvailable()) {
    try {
      const shared = Boolean(await getRedis().get(`loginlock:${id}`));
      if (!shared) attempts.delete(id);
      return shared;
    } catch {
      /* Redis stopped answering. Use this process. */
    }
  }
  return processLocked(id);
}

export async function clearLoginFailures(ip: string): Promise<void> {
  const id = lockId(ip);
  attempts.delete(id);
  await resetRateLimit(`login:${ip}`);
  if (!redisAvailable()) return;
  try {
    await getRedis().del(`loginfail:${id}`, `loginlock:${id}`);
  } catch {
    /* The in-process lock is already gone. */
  }
}
