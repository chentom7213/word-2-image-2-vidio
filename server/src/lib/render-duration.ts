/** A stored image duration of 0 stays 0. A video with no positive duration renders for 5 seconds. */
export function renderDuration(type: 'image' | 'video', duration: unknown): number {
  const value = Number(duration);
  if (Number.isFinite(value) && value > 0) return value;
  return type === 'video' ? 5 : 0;
}
