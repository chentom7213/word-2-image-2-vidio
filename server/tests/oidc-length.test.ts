import { describe, expect, it } from 'vitest';
import { oidcIdentityProblem } from '../src/lib/oidc-length.js';

const SUBJECT_TOO_LONG = '企业身份标识最长 255 字';
const ISSUER_TOO_LONG = '企业登录地址最长 500 字';

describe('oidcIdentityProblem', () => {
  it('subject 超过 255', () => {
    expect(oidcIdentityProblem('https://login.example.com', 's'.repeat(256))).toBe(SUBJECT_TOO_LONG);
  });

  it('subject 刚好 255', () => {
    expect(oidcIdentityProblem('https://login.example.com', 's'.repeat(255))).toBeNull();
  });

  it('issuer 超过 500', () => {
    expect(oidcIdentityProblem('i'.repeat(501), 'user-1')).toBe(ISSUER_TOO_LONG);
  });

  it('issuer 刚好 500', () => {
    expect(oidcIdentityProblem('i'.repeat(500), 'user-1')).toBeNull();
  });

  it('两个都超长时先报 subject', () => {
    expect(oidcIdentityProblem('i'.repeat(501), 's'.repeat(256))).toBe(SUBJECT_TOO_LONG);
  });

  it('两个都合法', () => {
    expect(oidcIdentityProblem('https://login.example.com', 'user-1')).toBeNull();
    expect(oidcIdentityProblem('i'.repeat(500), 's'.repeat(255))).toBeNull();
  });
});
