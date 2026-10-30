export type MemoryBucket = { expiresAt: number; count: number };

/** Same window as Redis INCR + EXPIRE: the first hit starts it, and a clock minute does not clear it. */
export function memoryRateAllows(
  buckets: Map<string, MemoryBucket>,
  key: string,
  limit: number,
  windowSec: number,
  nowMs: number,
): boolean {
  const current = buckets.get(key);
  if (!current || nowMs >= current.expiresAt) {
    buckets.set(key, { expiresAt: nowMs + windowSec * 1000, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}
