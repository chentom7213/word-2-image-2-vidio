// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { sliderDurationMax, videoDurationMax } from './plan-duration.ts';

describe('videoDurationMax', () => {
  it('stays at 15 when there is no plan', () => {
    expect(videoDurationMax(12, undefined)).toBe(15);
    expect(videoDurationMax(12, null)).toBe(15);
  });

  it('uses the plan cap when it is tighter than the model', () => {
    expect(videoDurationMax(12, 5)).toBe(5);
  });

  it('uses the model cap when it is tighter than the plan', () => {
    expect(videoDurationMax(10, 12)).toBe(10);
  });

  it('keeps a known plan above the guest cap of 15 seconds', () => {
    expect(videoDurationMax(20, 30)).toBe(20);
    expect(videoDurationMax(null, 30)).toBe(30);
    expect(videoDurationMax(0, 18)).toBe(18);
  });

  it('does not go below 2 seconds', () => {
    expect(videoDurationMax(12, 1)).toBe(2);
  });
});

describe('sliderDurationMax', () => {
  it('stays at 15 for a guest', () => {
    expect(
      sliderDurationMax({
        loggedIn: false,
        planKnown: false,
        modelMax: 12,
        planMax: undefined,
        currentDuration: 6,
      }),
    ).toBe(15);
  });

  it('uses the plan cap when a signed-in plan is known', () => {
    expect(
      sliderDurationMax({
        loggedIn: true,
        planKnown: true,
        modelMax: 12,
        planMax: 5,
        currentDuration: 6,
      }),
    ).toBe(5);
  });

  it('holds the current duration while a signed-in plan is still unknown', () => {
    expect(
      sliderDurationMax({
        loggedIn: true,
        planKnown: false,
        modelMax: 12,
        planMax: 5,
        currentDuration: 6,
      }),
    ).toBe(6);
  });

  it('stays at least 2 seconds when the current duration is below the minimum', () => {
    expect(
      sliderDurationMax({
        loggedIn: true,
        planKnown: false,
        modelMax: 12,
        planMax: undefined,
        currentDuration: 1,
      }),
    ).toBe(2);
  });

  it('keeps a duration above 15 seconds until the plan arrives', () => {
    expect(
      sliderDurationMax({
        loggedIn: true,
        planKnown: false,
        modelMax: 12,
        planMax: undefined,
        currentDuration: 20,
      }),
    ).toBe(20);
  });
});
