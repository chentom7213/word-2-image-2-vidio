import { describe, expect, it } from 'vitest';
import { optimizedPrompt } from '../../src/lib/optimize-prompt.ts';

describe('optimized prompt suffix', () => {
  it('adds the suffix once and drops the leading comma on an empty prompt', () => {
    const suffix = ', cinematic lighting';
    expect(optimizedPrompt('', suffix)).toBe('cinematic lighting');
    expect(optimizedPrompt('a street', suffix)).toBe('a street, cinematic lighting');
    expect(optimizedPrompt('a street, cinematic lighting', suffix)).toBe('a street, cinematic lighting');
  });
});
