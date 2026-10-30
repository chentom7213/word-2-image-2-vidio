import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX_LENGTH, PASSWORD_TOO_LONG, passwordTooLongMessage } from '../src/lib/password-length.js';

describe('passwordTooLongMessage', () => {
  it('超过', () => {
    expect(passwordTooLongMessage('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe(PASSWORD_TOO_LONG);
    expect(passwordTooLongMessage(`${'a'.repeat(PASSWORD_MAX_LENGTH)} `)).toBe(PASSWORD_TOO_LONG);
  });

  it('刚好', () => {
    expect(passwordTooLongMessage('a'.repeat(PASSWORD_MAX_LENGTH))).toBeNull();
  });

  it('空字符串', () => {
    expect(passwordTooLongMessage('')).toBeNull();
  });
});
