// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { promptTooLongMessage } from './prompt-length.ts';

describe('promptTooLongMessage', () => {
  it('returns the limit message when the trimmed prompt is longer than 4000', () => {
    expect(promptTooLongMessage(`  ${'字'.repeat(4001)}  `)).toBe('提示词最长 4000 字');
  });

  it('returns null when the trimmed prompt is exactly 4000', () => {
    expect(promptTooLongMessage(`  ${'字'.repeat(4000)}  `)).toBeNull();
  });

  it('returns null for an empty or whitespace prompt', () => {
    expect(promptTooLongMessage('')).toBeNull();
    expect(promptTooLongMessage('   \n\t  ')).toBeNull();
  });
});
