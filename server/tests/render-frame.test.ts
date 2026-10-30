import { describe, expect, it } from 'vitest';
import { renderFrame } from '../src/lib/render-frame.js';

describe('render frame fallback', () => {
  it('uses 1280×720 for a video whose sides are not positive', () => {
    expect(renderFrame('video', 0, 0)).toEqual({ width: 1280, height: 720 });
    expect(renderFrame('video', 0, 360)).toEqual({ width: 1280, height: 360 });
    expect(renderFrame('video', 640, 0)).toEqual({ width: 640, height: 720 });
  });

  it('uses 1024×1024 for an image whose sides are not positive', () => {
    expect(renderFrame('image', 0, 0)).toEqual({ width: 1024, height: 1024 });
    expect(renderFrame('image', 0, 600)).toEqual({ width: 1024, height: 600 });
    expect(renderFrame('image', 800, 0)).toEqual({ width: 800, height: 1024 });
  });
});