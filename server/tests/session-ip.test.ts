import { describe, expect, it } from 'vitest';
import { sessionIp } from '../src/lib/session-ip.js';

describe('sessionIp', () => {
  it('超过 45', () => {
    const value = `  ${'a'.repeat(50)}`;
    expect(value.length).toBeGreaterThan(45);
    expect(sessionIp(value)).toBe(value.slice(0, 45));
    expect(sessionIp(value)).toHaveLength(45);
  });

  it('刚好 45', () => {
    const value = ` ${'b'.repeat(43)} `;
    expect(value).toHaveLength(45);
    expect(sessionIp(value)).toBe(value);
  });

  it('空白保留', () => {
    expect(sessionIp('  127.0.0.1  ')).toBe('  127.0.0.1  ');
    expect(sessionIp('')).toBe('');
    expect(sessionIp(' '.repeat(50))).toBe(' '.repeat(45));
  });

  it('null', () => {
    expect(sessionIp(null)).toBeNull();
  });

  it('undefined', () => {
    expect(sessionIp(undefined)).toBeNull();
  });
});
