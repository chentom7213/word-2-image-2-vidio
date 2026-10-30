// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { passwordTooLongMessage } from './password-length.ts';

describe('passwordTooLongMessage', () => {
  it('returns the limit message when the raw password is longer than 72', () => {
    expect(passwordTooLongMessage('a'.repeat(73))).toBe('密码最长 72 位');
    expect(passwordTooLongMessage(`${'a'.repeat(72)} `)).toBe('密码最长 72 位');
  });

  it('returns null when the raw password is exactly 72', () => {
    expect(passwordTooLongMessage('a'.repeat(72))).toBeNull();
  });

  it('returns null for an empty password', () => {
    expect(passwordTooLongMessage('')).toBeNull();
  });
});
