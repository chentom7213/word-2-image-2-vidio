/** 次数为 1 要写过期时间。次数更大时，只有 TTL 小于 0 才补写；TTL 大于等于 0 不重新计时。 */
export function needsLoginFailureExpire(fails: number, ttlSeconds: number): boolean {
  if (fails === 1) return true;
  if (fails > 1 && ttlSeconds < 0) return true;
  return false;
}
