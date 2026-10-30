const FRAME_DIMENSION_MAX = 8192;

export const FRAME_DIMENSION_MESSAGE = '宽高需为 0 到 8192 的整数';

function invalidDimension(value: unknown): boolean {
  if (typeof value !== 'number') return false;
  return !Number.isInteger(value) || value < 0 || value > FRAME_DIMENSION_MAX;
}

/** 两个都缺省、null 或不是 number 时放行。任一 number 不是 0 到 8192 的整数时拒绝，NaN 和 Infinity 同样拒绝。 */
export function frameDimensionMessage(width: unknown, height: unknown): string | null {
  if (invalidDimension(width) || invalidDimension(height)) return FRAME_DIMENSION_MESSAGE;
  return null;
}
