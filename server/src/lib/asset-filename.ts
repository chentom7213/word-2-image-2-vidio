export const ASSET_FILENAME_MAX_LENGTH = 255;

export const ASSET_FILENAME_TOO_LONG = '文件名最长 255 字';

/** 按原文字符计，不 trim。超过上限才拒绝；空串和刚好到上限都放行。 */
export function assetFilenameTooLongMessage(filename: string): string | null {
  if (filename.length > ASSET_FILENAME_MAX_LENGTH) return ASSET_FILENAME_TOO_LONG;
  return null;
}
