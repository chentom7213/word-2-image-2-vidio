// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { inviteEmailLooksValid, keyNameTooLongMessage, orgNameTooLongMessage } from './team-field.ts';

describe('orgNameTooLongMessage', () => {
  it('returns the limit message when the trimmed name is longer than 120', () => {
    expect(orgNameTooLongMessage(`  ${'字'.repeat(121)}  `)).toBe('组织名称最长 120 字');
  });

  it('returns null when the trimmed name is exactly 120', () => {
    expect(orgNameTooLongMessage(`  ${'字'.repeat(120)}  `)).toBeNull();
  });

  it('returns null for an empty or whitespace name', () => {
    expect(orgNameTooLongMessage('')).toBeNull();
    expect(orgNameTooLongMessage('   \n\t  ')).toBeNull();
  });
});

describe('keyNameTooLongMessage', () => {
  it('returns the limit message when the trimmed name is longer than 80', () => {
    expect(keyNameTooLongMessage(`  ${'字'.repeat(81)}  `)).toBe('钥匙名称最长 80 字');
  });

  it('returns null when the trimmed name is exactly 80', () => {
    expect(keyNameTooLongMessage(`  ${'字'.repeat(80)}  `)).toBeNull();
  });

  it('returns null for an empty or whitespace name', () => {
    expect(keyNameTooLongMessage('')).toBeNull();
    expect(keyNameTooLongMessage('   \n\t  ')).toBeNull();
  });
});

describe('inviteEmailLooksValid', () => {
  it('returns true when the trimmed email matches the pattern', () => {
    expect(inviteEmailLooksValid('  user@example.com  ')).toBe(true);
  });

  it('returns false for a blank email or one without @', () => {
    expect(inviteEmailLooksValid('')).toBe(false);
    expect(inviteEmailLooksValid('   \n\t  ')).toBe(false);
    expect(inviteEmailLooksValid('userexample.com')).toBe(false);
  });
});
