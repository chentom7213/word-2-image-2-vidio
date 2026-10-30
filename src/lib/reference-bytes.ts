const AUDIO_MAX_BYTES = 15 * 1024 * 1024;
const MEDIA_MAX_BYTES = 50 * 1024 * 1024;

const AUDIO_TOO_LARGE = '参考音频不能超过 15MB';
const VIDEO_TOO_LARGE = '参考视频不能超过 50MB';
const IMAGE_TOO_LARGE = '参考图不能超过 50MB';

/** First over-limit asset in array order. An exact limit, a smaller size, or an empty list returns null. */
export function referenceByteMessage(
  assets: readonly { kind: 'image' | 'video' | 'audio'; size: number }[],
): string | null {
  for (const asset of assets) {
    if (!Number.isFinite(asset.size)) continue;
    if (asset.kind === 'audio' && asset.size > AUDIO_MAX_BYTES) return AUDIO_TOO_LARGE;
    if (asset.kind === 'video' && asset.size > MEDIA_MAX_BYTES) return VIDEO_TOO_LARGE;
    if (asset.kind === 'image' && asset.size > MEDIA_MAX_BYTES) return IMAGE_TOO_LARGE;
  }
  return null;
}
