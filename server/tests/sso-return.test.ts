import { describe, expect, it } from 'vitest';
import { ssoJustSucceeded, stripSsoParam } from '../../src/lib/sso-return.ts';

describe('SSO return', () => {
  it('recognizes only the success flag', () => {
    expect(ssoJustSucceeded('?sso=success')).toBe(true);
    expect(ssoJustSucceeded('sso=success&next=/video')).toBe(true);
    expect(ssoJustSucceeded('?sso=failed')).toBe(false);
    expect(ssoJustSucceeded('')).toBe(false);
  });

  it('removes the flag and keeps the rest of the URL', () => {
    expect(stripSsoParam('http://app.example/zh/video?sso=success&tab=1#shot')).toBe('/zh/video?tab=1#shot');
    expect(stripSsoParam('http://app.example/video?sso=success')).toBe('/video');
  });
});