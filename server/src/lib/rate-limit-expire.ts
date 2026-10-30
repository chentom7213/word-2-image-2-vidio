/** 只决定要不要补 EXPIRE，不改变 INCR。已有过期时间的键不重新计时。 */
export function needsRateLimitExpire(count: number, ttlSeconds: number): boolean {
  if (count === 1) return true;
  if (count > 1 && ttlSeconds < 0) return true;
  return false;
}
