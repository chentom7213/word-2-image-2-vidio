const FILENAME_TOO_LONG = '文件名最长 255 字';
const MAX_FILENAME_LENGTH = 255;

/** Raw filenames longer than 255 characters cannot be uploaded. */
export function assetFilenameTooLongMessage(filename: string): string | null {
  return filename.length > MAX_FILENAME_LENGTH ? FILENAME_TOO_LONG : null;
}
