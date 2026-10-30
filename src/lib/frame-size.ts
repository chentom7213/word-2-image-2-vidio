const MIN_SIDE = 2;
const MAX_SIDE = 8192;

function finitePositive(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Nearest even pixel, kept inside 2..8192. */
function evenSide(value: number): number {
  if (!Number.isFinite(value)) return MIN_SIDE;
  const even = Math.round(value / 2) * 2;
  if (even < MIN_SIDE) return MIN_SIDE;
  if (even > MAX_SIDE) return MAX_SIDE;
  return even;
}

/** Short side matches shortSide; the other side keeps the same aspect ratio. Both sides are even. */
export function frameSize(
  aspectWidth: number,
  aspectHeight: number,
  shortSide: number,
): { width: number; height: number } | null {
  if (!finitePositive(aspectWidth) || !finitePositive(aspectHeight) || !finitePositive(shortSide)) return null;

  const widthIsShort = aspectWidth <= aspectHeight;
  let width = widthIsShort ? shortSide : (shortSide * aspectWidth) / aspectHeight;
  let height = widthIsShort ? (shortSide * aspectHeight) / aspectWidth : shortSide;

  if (width > MAX_SIDE || height > MAX_SIDE) {
    if (width >= height) {
      height = (height * MAX_SIDE) / width;
      width = MAX_SIDE;
    } else {
      width = (width * MAX_SIDE) / height;
      height = MAX_SIDE;
    }
  }

  return { width: evenSide(width), height: evenSide(height) };
}
