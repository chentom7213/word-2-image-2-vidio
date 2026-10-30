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

/** 扩展名 → Content-Type。.jpg 与 .jpeg 都是 image/jpeg。 */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

/**
 * 对象键最后一个扩展名对应的 Content-Type。
 * 没有扩展名，或扩展名不在表里，返回 null。
 */
export function contentTypeForObjectKey(objectKey: string): string | null {
  const name = objectKey.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return CONTENT_TYPE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** 去掉分号后的参数、trim、转小写后查表。未知视频用 mp4，其余用 png。 */
export function outputExtension(mime: string | null | undefined, kind: string): string {
  const base = String(mime ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const mapped = EXTENSION_BY_MIME[base];
  if (mapped) return mapped;
  if (base.startsWith('video/') || kind === 'video') return 'mp4';
  return 'png';
}
