import { describe, expect, it } from 'vitest';
import { accessTokenExpMs, refreshDelayMs } from '../../src/lib/refresh-schedule.ts';

function token(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${body}.sig`;
}

describe('silent refresh schedule', () => {
  it('refreshes two minutes before the token exp', () => {
    const now = 1_700_000_000_000;
    const exp = Math.floor(now / 1000) + 15 * 60;
    const delay = refreshDelayMs(token({ exp }), now);
    expect(delay).toBe(13 * 60 * 1000);
    expect(accessTokenExpMs(token({ exp }))).toBe(exp * 1000);
  });

  it('refreshes immediately once the lead time has already passed', () => {
    const now = 1_700_000_000_000;
    const exp = Math.floor(now / 1000) + 60;
    expect(refreshDelayMs(token({ exp }), now)).toBe(0);
  });

  it('falls back to thirteen minutes when the token has no exp', () => {
    const now = 1_700_000_000_000;
    expect(refreshDelayMs(null, now)).toBe(13 * 60 * 1000);
    expect(refreshDelayMs('not-a-jwt', now)).toBe(13 * 60 * 1000);
    expect(accessTokenExpMs(token({ exp: 'soon' }))).toBeNull();
  });
});
