import { describe, expect, it } from 'vitest';
import { FRAME_DIMENSION_MESSAGE, frameDimensionMessage } from '../src/lib/frame-dimension.js';

describe('frameDimensionMessage', () => {
  it('超过 8192', () => {
    expect(frameDimensionMessage(8193, 100)).toBe(FRAME_DIMENSION_MESSAGE);
    expect(frameDimensionMessage(0, 8193)).toBe(FRAME_DIMENSION_MESSAGE);
    expect(frameDimensionMessage(Number.POSITIVE_INFINITY, 1080)).toBe(FRAME_DIMENSION_MESSAGE);
    expect(frameDimensionMessage(Number.NEGATIVE_INFINITY, 0)).toBe(FRAME_DIMENSION_MESSAGE);
  });

  it('小于 0', () => {
    expect(frameDimensionMessage(-1, 1080)).toBe(FRAME_DIMENSION_MESSAGE);
    expect(frameDimensionMessage(1920, -1)).toBe(FRAME_DIMENSION_MESSAGE);
  });

  it('小数', () => {
    expect(frameDimensionMessage(1.5, 1080)).toBe(FRAME_DIMENSION_MESSAGE);
    expect(frameDimensionMessage(1920, 0.1)).toBe(FRAME_DIMENSION_MESSAGE);
    expect(frameDimensionMessage(8192.5, undefined)).toBe(FRAME_DIMENSION_MESSAGE);
  });

  it('NaN', () => {
    expect(frameDimensionMessage(Number.NaN, 1080)).toBe(FRAME_DIMENSION_MESSAGE);
    expect(frameDimensionMessage(1920, Number.NaN)).toBe(FRAME_DIMENSION_MESSAGE);
    expect(frameDimensionMessage(Number.NaN, null)).toBe(FRAME_DIMENSION_MESSAGE);
  });

  it('刚好 0', () => {
    expect(frameDimensionMessage(0, 0)).toBeNull();
    expect(frameDimensionMessage(0, 1080)).toBeNull();
    expect(frameDimensionMessage(1920, 0)).toBeNull();
  });

  it('刚好 8192', () => {
    expect(frameDimensionMessage(8192, 8192)).toBeNull();
    expect(frameDimensionMessage(8192, 0)).toBeNull();
    expect(frameDimensionMessage(1, 8192)).toBeNull();
  });

  it('两个都合法', () => {
    expect(frameDimensionMessage(1920, 1080)).toBeNull();
    expect(frameDimensionMessage(1, 8191)).toBeNull();
  });

  it('只有一个非数字', () => {
    expect(frameDimensionMessage(1920, '1080')).toBeNull();
    expect(frameDimensionMessage(undefined, 1080)).toBeNull();
    expect(frameDimensionMessage(null, 720)).toBeNull();
    expect(frameDimensionMessage('1920', 1080)).toBeNull();
    expect(frameDimensionMessage(undefined, undefined)).toBeNull();
    expect(frameDimensionMessage(null, null)).toBeNull();
    expect(frameDimensionMessage('1920', '1080')).toBeNull();
  });
});
