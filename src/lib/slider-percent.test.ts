// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { sliderPercent } from './slider-percent.ts';

describe('sliderPercent', () => {
  it('returns 0 when max equals min', () => {
    expect(sliderPercent(2, 2, 2)).toBe(0);
    expect(sliderPercent(0, 0, 0)).toBe(0);
    expect(sliderPercent(5, 2, 2)).toBe(0);
  });

  it('returns 50 at the midpoint of a normal range', () => {
    expect(sliderPercent(50, 0, 100)).toBe(50);
    expect(sliderPercent(6, 2, 10)).toBe(50);
  });

  it('clamps a value outside the range to 0 or 100', () => {
    expect(sliderPercent(-10, 0, 100)).toBe(0);
    expect(sliderPercent(1, 2, 10)).toBe(0);
    expect(sliderPercent(150, 0, 100)).toBe(100);
    expect(sliderPercent(20, 2, 10)).toBe(100);
  });

  it('returns 0 when any argument or the result is NaN or Infinity', () => {
    expect(sliderPercent(Number.NaN, 0, 100)).toBe(0);
    expect(sliderPercent(50, Number.NaN, 100)).toBe(0);
    expect(sliderPercent(50, 0, Number.NaN)).toBe(0);
    expect(sliderPercent(Number.POSITIVE_INFINITY, 0, 100)).toBe(0);
    expect(sliderPercent(Number.NEGATIVE_INFINITY, 0, 100)).toBe(0);
    expect(sliderPercent(50, Number.POSITIVE_INFINITY, 100)).toBe(0);
    expect(sliderPercent(50, Number.NEGATIVE_INFINITY, 100)).toBe(0);
    expect(sliderPercent(50, 0, Number.POSITIVE_INFINITY)).toBe(0);
    expect(sliderPercent(50, 0, Number.NEGATIVE_INFINITY)).toBe(0);
    expect(sliderPercent(Number.MAX_VALUE, -Number.MAX_VALUE, 0)).toBe(0);
  });
});
