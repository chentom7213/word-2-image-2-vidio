// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { displayFrame } from './display-frame.ts';

describe('displayFrame', () => {
  it('replaces a missing video side with 1280×720 and keeps a positive side', () => {
    expect(displayFrame('video', 0, 0)).toEqual({ width: 1280, height: 720 });
    expect(displayFrame('video', 640, 0)).toEqual({ width: 640, height: 720 });
    expect(displayFrame('video', 0, 360)).toEqual({ width: 1280, height: 360 });
    expect(displayFrame('video', 1280, 720)).toEqual({ width: 1280, height: 720 });
  });

  it('replaces a missing image frame with 1024×1024 and keeps a positive image frame', () => {
    expect(displayFrame('image', 0, 0)).toEqual({ width: 1024, height: 1024 });
    expect(displayFrame('image', 800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('treats a side that is not a finite number as missing', () => {
    expect(displayFrame('video', Number.NaN, Number.NaN)).toEqual({ width: 1280, height: 720 });
    expect(displayFrame('video', undefined, 360)).toEqual({ width: 1280, height: 360 });
    expect(displayFrame('video', 640, null)).toEqual({ width: 640, height: 720 });
    expect(displayFrame('image', '800', '600')).toEqual({ width: 1024, height: 1024 });
    expect(displayFrame('image', Number.POSITIVE_INFINITY, 600)).toEqual({ width: 1024, height: 600 });
    expect(displayFrame('video', -640, Number.NEGATIVE_INFINITY)).toEqual({ width: 1280, height: 720 });
  });
});
