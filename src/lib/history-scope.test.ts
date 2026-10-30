// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { historyScope } from './history-scope.ts';

describe('historyScope', () => {
  it('treats /video, /en/video, and /zh/video as video', () => {
    expect(historyScope('/video')).toBe('video');
    expect(historyScope('/en/video')).toBe('video');
    expect(historyScope('/zh/video')).toBe('video');
  });

  it('treats /image, /en/image, and /zh/image as image', () => {
    expect(historyScope('/image')).toBe('image');
    expect(historyScope('/en/image')).toBe('image');
    expect(historyScope('/zh/image')).toBe('image');
  });

  it('ignores trailing slashes', () => {
    expect(historyScope('/video/')).toBe('video');
    expect(historyScope('/en/video/')).toBe('video');
    expect(historyScope('/zh/video//')).toBe('video');
    expect(historyScope('/image/')).toBe('image');
    expect(historyScope('/en/image/')).toBe('image');
    expect(historyScope('/zh/image///')).toBe('image');
    expect(historyScope('/assets/')).toBeNull();
  });

  it('returns null for other paths, including assets', () => {
    expect(historyScope('/assets')).toBeNull();
    expect(historyScope('/en/assets')).toBeNull();
    expect(historyScope('/zh/assets')).toBeNull();
    expect(historyScope('/')).toBeNull();
    expect(historyScope('/canvas')).toBeNull();
    expect(historyScope('/en')).toBeNull();
    expect(historyScope('/zh')).toBeNull();
    expect(historyScope('/fr/video')).toBeNull();
    expect(historyScope('/en/video/extra')).toBeNull();
    expect(historyScope('/zh/image/extra')).toBeNull();
    expect(historyScope('/clip')).toBeNull();
  });

  it('matches whole segments instead of substrings', () => {
    expect(historyScope('/videos')).toBeNull();
    expect(historyScope('/images')).toBeNull();
    expect(historyScope('/video-studio')).toBeNull();
    expect(historyScope('/my-video')).toBeNull();
    expect(historyScope('/imageable')).toBeNull();
    expect(historyScope('/assets/video')).toBeNull();
    expect(historyScope('/assets/image')).toBeNull();
    expect(historyScope('/en/videos')).toBeNull();
    expect(historyScope('/zh/images')).toBeNull();
    expect(historyScope('/video/image')).toBeNull();
    expect(historyScope('/image/video')).toBeNull();
    expect(historyScope('/en//video')).toBeNull();
  });
});
