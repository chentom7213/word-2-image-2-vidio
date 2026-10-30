const FRAME_DIMENSION = '宽高需为 0 到 8192 的整数';
const MAX_FRAME_DIMENSION = 8192;

function invalidDimension(value: unknown): boolean {
  return typeof value === 'number' && (!Number.isInteger(value) || value < 0 || value > MAX_FRAME_DIMENSION);
}

/** A numeric side must be an integer from 0 through 8192. Non-numbers are ignored. */
export function frameDimensionMessage(width: unknown, height: unknown): string | null {
  if (invalidDimension(width) || invalidDimension(height)) return FRAME_DIMENSION;
  return null;
}
