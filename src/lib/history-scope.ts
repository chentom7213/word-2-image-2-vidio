export type HistoryScope = 'image' | 'video';

const LOCALES = new Set(['en', 'zh']);

/**
 * Studio history follows a path segment, not a substring.
 * `/video`, `/en/video`, and `/zh/video` are video; image paths match the same way.
 * Every other path, including `/assets`, is null. Trailing slashes are ignored.
 */
export function historyScope(pathname: string): HistoryScope | null {
  const parts = pathname.replace(/\/+$/, '').split('/');
  const segments = parts[0] === '' ? parts.slice(1) : parts;
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) return null;
  const kind = segments.length === 1 ? segments[0] : segments.length === 2 && LOCALES.has(segments[0]) ? segments[1] : '';
  if (kind === 'image' || kind === 'video') return kind;
  return null;
}
