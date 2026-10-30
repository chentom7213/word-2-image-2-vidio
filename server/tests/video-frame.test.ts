import { describe, expect, it } from 'vitest';
import { resolvedVideoFrame } from '../src/lib/video-frame.js';

describe('resolvedVideoFrame', () => {
  it('1080p、720p、480p 按 16:9 补齐', () => {
    expect(resolvedVideoFrame('video', '1080p', 0, 0)).toEqual({ width: 1920, height: 1080 });
    expect(resolvedVideoFrame('video', '720p', 0, 0)).toEqual({ width: 1280, height: 720 });
    expect(resolvedVideoFrame('video', '480p', 0, 0)).toEqual({ width: 854, height: 480 });
  });

  it('已有宽高保持原尺寸', () => {
    expect(resolvedVideoFrame('video', '480p', 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(resolvedVideoFrame('video', '1080p', 640, 0)).toEqual({ width: 640, height: 0 });
    expect(resolvedVideoFrame('video', '1080p', 0, 360)).toEqual({ width: 0, height: 360 });
  });

  it('图片任务不改', () => {
    expect(resolvedVideoFrame('image', '1080p', 0, 0)).toEqual({ width: 0, height: 0 });
    expect(resolvedVideoFrame('image', '720p', 800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('空清晰度或不匹配时仍是 0×0', () => {
    expect(resolvedVideoFrame('video', '', 0, 0)).toEqual({ width: 0, height: 0 });
    expect(resolvedVideoFrame('video', null, 0, 0)).toEqual({ width: 0, height: 0 });
    expect(resolvedVideoFrame('video', undefined, 0, 0)).toEqual({ width: 0, height: 0 });
    expect(resolvedVideoFrame('video', '1080', 0, 0)).toEqual({ width: 0, height: 0 });
    expect(resolvedVideoFrame('video', '4k', 0, 0)).toEqual({ width: 0, height: 0 });
  });

  it('长边超过 8192 时压到 8192 并按比例收短边', () => {
    expect(resolvedVideoFrame('video', '4608p', 0, 0)).toEqual({ width: 8192, height: 4608 });
    expect(resolvedVideoFrame('video', '5000p', 0, 0)).toEqual({ width: 8192, height: 4608 });
  });

  it('边长取偶数且不小于 2', () => {
    expect(resolvedVideoFrame('video', '1p', 0, 0)).toEqual({ width: 4, height: 2 });
    const frame = resolvedVideoFrame('video', '481p', 0, 0);
    expect(frame.width % 2).toBe(0);
    expect(frame.height % 2).toBe(0);
    expect(frame.width).toBeGreaterThanOrEqual(2);
    expect(frame.height).toBeGreaterThanOrEqual(2);
  });
});
