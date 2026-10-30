import { describe, expect, it } from 'vitest';
import { logoutMayClearCookie } from '../src/lib/logout-cookie.js';

describe('logout cookie owner', () => {
  it('clears when the access token and the cookie are the same user', () => {
    expect(logoutMayClearCookie('user-a', 'user-a')).toBe(true);
  });

  it('clears when the request has no access token', () => {
    expect(logoutMayClearCookie(null, 'user-a')).toBe(true);
  });

  it('clears when the cookie is not a live session', () => {
    expect(logoutMayClearCookie('user-a', null)).toBe(true);
  });

  it('keeps the cookie when it belongs to someone else', () => {
    expect(logoutMayClearCookie('user-a', 'user-b')).toBe(false);
  });

  it('keeps a live cookie when the access token cannot be read', () => {
    expect(logoutMayClearCookie(null, 'user-b', true)).toBe(false);
  });
});
