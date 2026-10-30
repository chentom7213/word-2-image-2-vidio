import { describe, expect, it } from 'vitest';
import { PROMPT_MAX_LENGTH, PROMPT_TOO_LONG, promptTooLongMessage } from '../src/lib/prompt-length.js';

describe('promptTooLongMessage', () => {
  it('超过', () => {
    expect(promptTooLongMessage('字'.repeat(PROMPT_MAX_LENGTH + 1))).toBe(PROMPT_TOO_LONG);
    expect(promptTooLongMessage(`  ${'字'.repeat(PROMPT_MAX_LENGTH + 1)}  `)).toBe(PROMPT_TOO_LONG);
  });

  it('刚好', () => {
    expect(promptTooLongMessage('字'.repeat(PROMPT_MAX_LENGTH))).toBeNull();
    expect(promptTooLongMessage(`\n${'字'.repeat(PROMPT_MAX_LENGTH)}\t`)).toBeNull();
  });

  it('空白', () => {
    expect(promptTooLongMessage('')).toBeNull();
    expect(promptTooLongMessage('   ')).toBeNull();
    expect(promptTooLongMessage('\n\t ')).toBeNull();
  });
});
