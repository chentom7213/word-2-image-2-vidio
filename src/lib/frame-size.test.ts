// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { frameSize } from './frame-size.ts';

describe('frameSize', () => {
  it('fits 16:9 so the short side is the requested length', () => {
    expect(frameSize(1280, 720, 720)).toEqual({ width: 1280, height: 720 });
    expect(frameSize(1280, 720, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(frameSize(1280, 720, 480)).toEqual({ width: 854, height: 480 });
  });

  it('uses width as the short side for a portrait ratio', () => {
    expect(frameSize(720, 1280, 1080)).toEqual({ width: 1080, height: 1920 });
  });

  it('keeps a square on the short side', () => {
    expect(frameSize(1024, 1024, 720)).toEqual({ width: 720, height: 720 });
  });

  it('returns null when the ratio or the short side is not a finite positive number', () => {
    expect(frameSize(0, 720, 720)).toBeNull();
    expect(frameSize(-1280, 720, 720)).toBeNull();
    expect(frameSize(Number.NaN, 720, 720)).toBeNull();
    expect(frameSize(Number.POSITIVE_INFINITY, 720, 720)).toBeNull();
    expect(frameSize(Number.NEGATIVE_INFINITY, 720, 720)).toBeNull();
    expect(frameSize(1280, 0, 720)).toBeNull();
    expect(frameSize(1280, -720, 720)).toBeNull();
    expect(frameSize(1280, Number.NaN, 720)).toBeNull();
    expect(frameSize(1280, Number.POSITIVE_INFINITY, 720)).toBeNull();
    expect(frameSize(1280, 720, 0)).toBeNull();
    expect(frameSize(1280, 720, -480)).toBeNull();
    expect(frameSize(1280, 720, Number.NaN)).toBeNull();
    expect(frameSize(1280, 720, Number.POSITIVE_INFINITY)).toBeNull();
    expect(frameSize(1280, 720, Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('presses the long side down to 8192 and shrinks the short side to an even length', () => {
    expect(frameSize(1280, 720, 5000)).toEqual({ width: 8192, height: 4608 });
    expect(frameSize(720, 1280, 5000)).toEqual({ width: 4608, height: 8192 });
    expect(frameSize(1024, 1024, 9000)).toEqual({ width: 8192, height: 8192 });
  });

  it('snaps both sides to even pixels and never goes below 2', () => {
    expect(frameSize(1280, 720, 721)).toEqual({ width: 1282, height: 722 });
    expect(frameSize(1280, 720, 1)).toEqual({ width: 2, height: 2 });
  });
});
