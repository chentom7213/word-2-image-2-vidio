// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { videoParamSizeSummary } from './video-param-summary.ts';

describe('videoParamSizeSummary', () => {
  it('returns the aspect name when one is present', () => {
    expect(videoParamSizeSummary('video_aspect_landscape', 1280, 720)).toBe('video_aspect_landscape');
    expect(videoParamSizeSummary('video_aspect_portrait', 0, 0)).toBe('video_aspect_portrait');
  });

  it('returns pixel size when the aspect name is empty and both sides are positive', () => {
    expect(videoParamSizeSummary('', 1280, 720)).toBe('1280×720');
    expect(videoParamSizeSummary(null, 720, 1280)).toBe('720×1280');
    expect(videoParamSizeSummary(undefined, 1024, 1024)).toBe('1024×1024');
  });

  it('returns null when width and height are not both finite and positive', () => {
    expect(videoParamSizeSummary(null, 0, 0)).toBeNull();
    expect(videoParamSizeSummary('', 0, 720)).toBeNull();
    expect(videoParamSizeSummary(null, 1280, 0)).toBeNull();
    expect(videoParamSizeSummary(null, -1280, 720)).toBeNull();
    expect(videoParamSizeSummary(null, Number.NaN, 720)).toBeNull();
    expect(videoParamSizeSummary(null, Number.POSITIVE_INFINITY, 720)).toBeNull();
  });
});
