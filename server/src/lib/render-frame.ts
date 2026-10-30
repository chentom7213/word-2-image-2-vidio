/** A zero side is the automatic size. Video falls back to 1280×720, images to 1024×1024. */
export function renderFrame(
  type: 'image' | 'video',
  width: unknown,
  height: unknown,
): { width: number; height: number } {
  const widthNumber = Number(width);
  const heightNumber = Number(height);
  const fallbackWidth = type === 'video' ? 1280 : 1024;
  const fallbackHeight = type === 'video' ? 720 : 1024;
  return {
    width: Number.isFinite(widthNumber) && widthNumber > 0 ? widthNumber : fallbackWidth,
    height: Number.isFinite(heightNumber) && heightNumber > 0 ? heightNumber : fallbackHeight,
  };
}
