const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const IMAGE_SIDE = 1024;

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 播放器显示用的宽高。某一边不是有限正数时，按渲染回退替换这一边：视频 1280×720，图片 1024×1024。 */
export function displayFrame(
  type: 'image' | 'video',
  width: unknown,
  height: unknown,
): { width: number; height: number } {
  const fallbackWidth = type === 'video' ? VIDEO_WIDTH : IMAGE_SIDE;
  const fallbackHeight = type === 'video' ? VIDEO_HEIGHT : IMAGE_SIDE;
  return {
    width: finitePositive(width) ? width : fallbackWidth,
    height: finitePositive(height) ? height : fallbackHeight,
  };
}
