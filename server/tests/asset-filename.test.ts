import { describe, expect, it } from 'vitest';
import { ASSET_FILENAME_MAX_LENGTH, ASSET_FILENAME_TOO_LONG, assetFilenameTooLongMessage } from '../src/lib/asset-filename.js';

describe('assetFilenameTooLongMessage', () => {
  it('超过', () => {
    expect(assetFilenameTooLongMessage('a'.repeat(ASSET_FILENAME_MAX_LENGTH + 1))).toBe(ASSET_FILENAME_TOO_LONG);
    expect(assetFilenameTooLongMessage(`${'a'.repeat(ASSET_FILENAME_MAX_LENGTH)} `)).toBe(ASSET_FILENAME_TOO_LONG);
  });

  it('刚好', () => {
    expect(assetFilenameTooLongMessage('a'.repeat(ASSET_FILENAME_MAX_LENGTH))).toBeNull();
  });

  it('空字符串', () => {
    expect(assetFilenameTooLongMessage('')).toBeNull();
  });
});
