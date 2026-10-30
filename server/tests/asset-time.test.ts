import { describe, expect, it } from 'vitest';
import { toMillis } from '../src/lib/dto.js';

describe('asset timestamps', () => {
  it('reads a MySQL datetime as UTC', () => {
    expect(toMillis('2026-10-31 16:30:00.000')).toBe(Date.parse('2026-10-31T16:30:00.000Z'));
  });

  it('reads a zone-less T datetime as UTC and keeps an existing zone', () => {
    expect(toMillis('2026-10-27T06:00:00')).toBe(Date.parse('2026-10-27T06:00:00Z'));
    expect(toMillis('2026-10-27T06:00:00Z')).toBe(Date.parse('2026-10-27T06:00:00Z'));
    expect(toMillis('2026-10-27T14:00:00+08:00')).toBe(Date.parse('2026-10-27T14:00:00+08:00'));
  });
});
