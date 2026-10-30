import { describe, expect, it } from 'vitest';
import { formatUtcClock, formatUtcLocal } from './utc-time';

describe('UTC clock display', () => {
  it('shows the UTC hour for a MySQL datetime, including fractional seconds', () => {
    expect(formatUtcClock('2026-10-26 11:14:02')).toBe('2026-10-26 11:14');
    expect(formatUtcClock('2026-10-26 11:14:02.123')).toBe('2026-10-26 11:14');
    expect(formatUtcClock('2026-10-26T11:14:02')).toBe('2026-10-26 11:14');
  });

  it('keeps an explicit offset and leaves unreadable text unchanged', () => {
    expect(formatUtcClock('2026-10-26T19:14:00+08:00')).toBe('2026-10-26 11:14');
    expect(formatUtcClock('not-a-time')).toBe('not-a-time');
  });
});

describe('UTC local conversion', () => {
  it('converts MySQL, zone-less T, and an existing offset to the same local clock', () => {
    const ms = Date.parse('2026-10-26T11:14:02Z');
    const d = new Date(ms);
    const pad = (n: number) => n.toString().padStart(2, '0');
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(formatUtcLocal('2026-10-26 11:14:02')).toBe(expected);
    expect(formatUtcLocal('2026-10-26T11:14:02')).toBe(expected);
    expect(formatUtcLocal('2026-10-26T11:14:02Z')).toBe(expected);
    expect(formatUtcLocal('2026-10-26T19:14:02+08:00')).toBe(expected);
    expect(formatUtcLocal('not-a-time')).toBe('not-a-time');
  });
});