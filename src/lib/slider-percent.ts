/** Track fill and thumb position. A zero-width range or a non-finite input stays at the start. */
export function sliderPercent(value: number, min: number, max: number): number {
  if (max === min) return 0;
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return 0;
  const percent = ((value - min) / (max - min)) * 100;
  if (!Number.isFinite(percent)) return 0;
  if (percent < 0) return 0;
  if (percent > 100) return 100;
  return percent;
}
