// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { MAX_ASSET_UPLOAD_BYTES } from './api.ts';
import { referenceCountMax, referenceMaxBytes } from './reference-limit.ts';

describe('referenceMaxBytes', () => {
  it('matches the asset upload cap for images and videos', () => {
    expect(referenceMaxBytes('image')).toBe(MAX_ASSET_UPLOAD_BYTES);
    expect(referenceMaxBytes('video')).toBe(MAX_ASSET_UPLOAD_BYTES);
  });

  it('keeps audio at 15MB', () => {
    expect(referenceMaxBytes('audio')).toBe(15 * 1024 * 1024);
  });
});

describe('referenceCountMax', () => {
  it('allows 9 reference images', () => {
    expect(referenceCountMax('image')).toBe(9);
  });

  it('allows 3 reference videos and audios', () => {
    expect(referenceCountMax('video')).toBe(3);
    expect(referenceCountMax('audio')).toBe(3);
  });
});
