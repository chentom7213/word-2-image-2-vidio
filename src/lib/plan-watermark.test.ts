// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { planWatermarkState } from './plan-watermark.ts';

describe('planWatermarkState', () => {
  it('returns true when watermark is true', () => {
    expect(planWatermarkState({ watermark: true })).toBe(true);
  });

  it('returns false when watermark is false', () => {
    expect(planWatermarkState({ watermark: false })).toBe(false);
  });

  it('returns null when watermark is missing', () => {
    expect(planWatermarkState({})).toBeNull();
    expect(planWatermarkState(undefined)).toBeNull();
  });

  it('returns null when watermark is a string', () => {
    expect(planWatermarkState({ watermark: 'yes' })).toBeNull();
  });

  it('returns null when watermark is null', () => {
    expect(planWatermarkState({ watermark: null })).toBeNull();
    expect(planWatermarkState(null)).toBeNull();
  });
});
