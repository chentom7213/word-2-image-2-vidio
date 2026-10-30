import { describe, expect, it } from 'vitest';
import { estimateCost, validateAgainstModel, type ModelDto } from '../src/services/models.js';

/**
 * Pricing is the single most dangerous piece of logic in the product: a bug
 * here either over-charges users or gives away compute. These cases pin the
 * contract that `POST /api/generations` relies on.
 */

const video: ModelDto = {
  id: 'v',
  name: 'Video',
  kind: 'video',
  priceLabel: '55积分/秒',
  priceAmount: 55,
  priceUnit: 'per_second',
  tag: null,
  refs: ['image'],
  durations: [3, 5, 10],
  provider: 'x',
  maxDuration: 10,
};

const perCall: ModelDto = { ...video, id: 'c', priceUnit: 'per_call', priceAmount: 100, maxDuration: null };
const perImage: ModelDto = { ...video, id: 'i', kind: 'image', priceUnit: 'per_image', priceAmount: 25 };

describe('estimateCost', () => {
  it('charges per second for video', () => {
    expect(estimateCost({ model: video, duration: 5, count: 1 })).toBe(275);
    expect(estimateCost({ model: video, duration: 10, count: 1 })).toBe(550);
  });

  it('charges the flat rate for per_call regardless of duration', () => {
    expect(estimateCost({ model: perCall, duration: 10, count: 1 })).toBe(100);
  });

  it('multiplies by count for per_image', () => {
    expect(estimateCost({ model: perImage, duration: 0, count: 4 })).toBe(100);
  });

  it('never charges zero for a zero/negative duration', () => {
    // A 0s request must be clamped to 1 second, never free.
    expect(estimateCost({ model: video, duration: 0, count: 1 })).toBe(55);
    expect(estimateCost({ model: video, duration: -5, count: 1 })).toBe(55);
  });

  it('never charges zero for a zero count', () => {
    expect(estimateCost({ model: perImage, duration: 0, count: 0 })).toBe(25);
  });
});

describe('validateAgainstModel', () => {
  it('rejects a video request over the model max duration', () => {
    expect(validateAgainstModel(video, { duration: 11, count: 1, refCount: 0 })).toMatch(/最长支持/);
  });

  it('accepts a request at exactly the max duration', () => {
    expect(validateAgainstModel(video, { duration: 10, count: 1, refCount: 0 })).toBeNull();
  });

  it('rejects a zero duration video', () => {
    expect(validateAgainstModel(video, { duration: 0, count: 1, refCount: 0 })).toMatch(/时长/);
  });

  it('rejects counts outside 1..8', () => {
    expect(validateAgainstModel(perImage, { duration: 0, count: 0, refCount: 0 })).toMatch(/1~8/);
    expect(validateAgainstModel(perImage, { duration: 0, count: 9, refCount: 0 })).toMatch(/1~8/);
  });

  it('rejects refs on a model with no ref capability', () => {
    const noRefs: ModelDto = { ...perImage, refs: [] };
    expect(validateAgainstModel(noRefs, { duration: 0, count: 1, refCount: 2 })).toMatch(/参考素材/);
  });

  it('allows refs when the model declares them', () => {
    expect(validateAgainstModel(video, { duration: 5, count: 1, refCount: 1 })).toBeNull();
  });

  it('rejects a video ref when the model only supports images', () => {
    expect(validateAgainstModel(video, { duration: 5, count: 1, refCount: 1, refKinds: ['video'] })).toBe(
      '该模型不支持参考视频',
    );
  });

  it('accepts an image ref when the model supports images', () => {
    expect(validateAgainstModel(video, { duration: 5, count: 1, refCount: 1, refKinds: ['image'] })).toBeNull();
  });
});
