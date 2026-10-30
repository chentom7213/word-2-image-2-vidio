import { describe, expect, it } from 'vitest';
import { asUtcDate, isMonthlyGrantDue } from '../src/services/monthlyCredits.js';

describe('monthly subscription credit schedule', () => {
  const now = new Date('2026-10-23T12:00:00.000Z');

  it('grants the first period when no prior grant exists', () => {
    expect(isMonthlyGrantDue(null, now)).toBe(true);
  });

  it('does not grant twice within the same 30-day subscription period', () => {
    expect(isMonthlyGrantDue(new Date('2026-10-01T12:00:00.000Z'), now)).toBe(false);
  });

  it('becomes due exactly 30 days after the previous period', () => {
    expect(isMonthlyGrantDue(new Date('2026-09-23T12:00:00.000Z'), now)).toBe(true);
  });

  it('reads a zone-less period start as UTC', () => {
    expect(asUtcDate('2026-10-27T06:00:00').toISOString()).toBe('2026-10-27T06:00:00.000Z');
    expect(asUtcDate('2026-10-27 06:00:00').toISOString()).toBe('2026-10-27T06:00:00.000Z');
    expect(asUtcDate('2026-10-27T14:00:00+08:00').toISOString()).toBe('2026-10-27T06:00:00.000Z');
  });
});
