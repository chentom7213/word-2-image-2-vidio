// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { assetFilenameTooLongMessage } from './asset-filename.ts';

describe('assetFilenameTooLongMessage', () => {
  it('returns the limit message when the raw filename is longer than 255', () => {
    expect(assetFilenameTooLongMessage('字'.repeat(256))).toBe('文件名最长 255 字');
    expect(assetFilenameTooLongMessage(`${'字'.repeat(255)} `)).toBe('文件名最长 255 字');
  });

  it('returns null when the raw filename is exactly 255', () => {
    expect(assetFilenameTooLongMessage('字'.repeat(255))).toBeNull();
  });

  it('returns null for an empty filename', () => {
    expect(assetFilenameTooLongMessage('')).toBeNull();
  });
});
