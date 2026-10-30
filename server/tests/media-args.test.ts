import { describe, expect, it } from 'vitest';
import { env } from '../src/env.js';
import { buildFfmpegArgs, renderImage, renderVideo } from '../src/render/media.js';

describe('ffmpeg resource arguments', () => {
  it('caps encoder threads using the configured single-machine limit', () => {
    const args = buildFfmpegArgs({
      inW: 320,
      inH: 180,
      outW: 1280,
      outH: 720,
      fps: 24,
      seconds: 5,
      outPath: 'output.mp4',
    });
    const threads = args.indexOf('-threads');
    expect(threads).toBeGreaterThan(-1);
    expect(args[threads + 1]).toBe(String(env.render.ffmpegThreads));
    expect(Number(args[threads + 1])).toBeGreaterThan(0);
  });
});

describe('render cancellation', () => {
  it('rejects pre-cancelled image and video renders before creating work', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = {
      prompt: 'cancelled',
      width: 64,
      height: 64,
      duration: 1,
      count: 1,
      seed: 'seed',
      fps: 1,
      signal: controller.signal,
    };

    await expect(renderImage(request)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(renderVideo(request)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
