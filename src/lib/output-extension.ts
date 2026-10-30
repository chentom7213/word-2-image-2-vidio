const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

/** 与服务端一样：去掉分号后的参数，trim，再转小写。对不上时，视频用 mp4，其余用 png。 */
export function outputExtension(mime: string | null | undefined, kind: string): string {
  const base = String(mime ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const mapped = EXTENSION_BY_MIME[base];
  if (mapped) return mapped;
  if (base.startsWith('video/') || kind === 'video') return 'mp4';
  return 'png';
}
