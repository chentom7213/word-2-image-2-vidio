const MIN_SIDE = 2;
const MAX_SIDE = 8192;

/** 收到偶数，并抬到最小边。上限留给长边压缩处理。 */
function evenSide(value: number): number {
  if (!Number.isFinite(value)) return MAX_SIDE;
  const even = Math.round(value / 2) * 2;
  if (!Number.isFinite(even)) return MAX_SIDE;
  return even < MIN_SIDE ? MIN_SIDE : even;
}

/**
 * 视频且宽高都是 0、清晰度是整数加 p 时，按 16:9 补齐画幅。
 * 较短边对齐该数字；两边取偶数，落在 2 到 8192。
 * 长边超过 8192 时压到 8192，再按比例收短边。
 */
export function resolvedVideoFrame(
  type: string,
  resolution: string | null | undefined,
  width: number,
  height: number,
): { width: number; height: number } {
  if (type !== 'video' || width !== 0 || height !== 0) return { width, height };

  const matched = typeof resolution === 'string' ? /^(\d+)p$/.exec(resolution) : null;
  if (!matched) return { width: 0, height: 0 };

  let shortSide = evenSide(Number(matched[1]));
  let longSide = evenSide((shortSide * 16) / 9);
  if (longSide > MAX_SIDE || shortSide > MAX_SIDE) {
    longSide = MAX_SIDE;
    shortSide = evenSide((longSide * 9) / 16);
    if (shortSide > MAX_SIDE) shortSide = MAX_SIDE;
  }
  return { width: longSide, height: shortSide };
}
