const STORED_COST_MAX = 2_147_483_647;

/** 只有安全整数且在 0 到 2147483647 之间时原样返回。其余返回 0，不四舍五入。 */
export function storedCostActual(value: unknown): number {
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= STORED_COST_MAX
  ) {
    return value;
  }
  return 0;
}
