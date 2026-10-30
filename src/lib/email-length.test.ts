// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { emailTooLongMessage } from './email-length.ts';

describe('emailTooLongMessage', () => {
  it('returns the limit message when the trimmed email is longer than 190', () => {
    expect(emailTooLongMessage(`  ${'a'.repeat(191)}  `)).toBe('邮箱最长 190 字');
  });

  it('returns null when the trimmed email is exactly 190', () => {
    expect(emailTooLongMessage(`  ${'a'.repeat(190)}  `)).toBeNull();
    expect(emailTooLongMessage('a'.repeat(190))).toBeNull();
  });

  it('returns null for an empty email', () => {
    expect(emailTooLongMessage('')).toBeNull();
  });
});
