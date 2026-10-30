// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { frameDimensionMessage } from './frame-dimension.ts';

const MESSAGE = '宽高需为 0 到 8192 的整数';

describe('frameDimensionMessage', () => {
  it('returns the limit message when either side is greater than 8192', () => {
    expect(frameDimensionMessage(8193, 1080)).toBe(MESSAGE);
    expect(frameDimensionMessage(1920, 8193)).toBe(MESSAGE);
  });

  it('returns the limit message when either side is less than 0', () => {
    expect(frameDimensionMessage(-1, 1080)).toBe(MESSAGE);
    expect(frameDimensionMessage(1920, -1)).toBe(MESSAGE);
  });

  it('returns the limit message for a fractional side', () => {
    expect(frameDimensionMessage(1920.5, 1080)).toBe(MESSAGE);
    expect(frameDimensionMessage(1920, 1080.1)).toBe(MESSAGE);
  });

  it('returns the limit message for NaN and Infinity', () => {
    expect(frameDimensionMessage(Number.NaN, 1080)).toBe(MESSAGE);
    expect(frameDimensionMessage(1920, Number.NaN)).toBe(MESSAGE);
    expect(frameDimensionMessage(Number.POSITIVE_INFINITY, 1080)).toBe(MESSAGE);
    expect(frameDimensionMessage(1920, Number.NEGATIVE_INFINITY)).toBe(MESSAGE);
  });

  it('returns null for exactly 0', () => {
    expect(frameDimensionMessage(0, 0)).toBeNull();
    expect(frameDimensionMessage(0, 1080)).toBeNull();
  });

  it('returns null for exactly 8192', () => {
    expect(frameDimensionMessage(8192, 8192)).toBeNull();
    expect(frameDimensionMessage(1920, 8192)).toBeNull();
  });

  it('returns null when both sides are integers inside the range', () => {
    expect(frameDimensionMessage(1920, 1080)).toBeNull();
  });

  it('returns null when only one value is not a number', () => {
    expect(frameDimensionMessage(1920, undefined)).toBeNull();
    expect(frameDimensionMessage('1080', 720)).toBeNull();
  });

  it('returns null when neither value is a number', () => {
    expect(frameDimensionMessage(undefined, null)).toBeNull();
    expect(frameDimensionMessage('1920', '1080')).toBeNull();
  });
});
