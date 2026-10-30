// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { referenceStill } from './reference-still.ts';

const video = { kind: 'video', url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' };
const audio = { kind: 'audio', url: 'https://cdn.example/tone.mp3', mime: 'audio/mpeg' };
const sprite = { kind: 'sprite', url: 'https://cdn.example/sheet.webp', mime: 'image/webp' };

describe('referenceStill', () => {
  it('只有视频产物时不选它', () => {
    expect(referenceStill({ outputs: [video], posterUrl: null })).toBeNull();
    expect(referenceStill({ outputs: [video, audio, sprite], posterUrl: null })).toBeNull();
  });

  it('有 poster 时用 poster 而不是视频', () => {
    expect(
      referenceStill({
        outputs: [
          video,
          { kind: 'poster', url: '', mime: 'image/png' },
          { kind: 'poster', url: 'https://cdn.example/poster.jpg', mime: 'image/jpeg' },
          { kind: 'thumbnail', url: 'https://cdn.example/thumb.webp', mime: 'image/webp' },
        ],
        posterUrl: 'https://cdn.example/legacy.jpg',
      }),
    ).toEqual({ url: 'https://cdn.example/poster.jpg', mime: 'image/jpeg' });
  });

  it('有 image 时优先 image', () => {
    expect(
      referenceStill({
        outputs: [
          video,
          { kind: 'poster', url: 'https://cdn.example/poster.jpg', mime: 'image/jpeg' },
          { kind: 'image', url: '', mime: 'image/png' },
          { kind: 'image', url: 'https://cdn.example/still.png', mime: 'image/png' },
          { kind: 'thumbnail', url: 'https://cdn.example/thumb.webp', mime: 'image/webp' },
          audio,
          sprite,
        ],
        posterUrl: 'https://cdn.example/legacy.jpg',
      }),
    ).toEqual({ url: 'https://cdn.example/still.png', mime: 'image/png' });
  });

  it('只有 posterUrl 时用它，没有 mime 时按 image/jpeg', () => {
    expect(referenceStill({ outputs: [], posterUrl: 'https://cdn.example/legacy.jpg' })).toEqual({
      url: 'https://cdn.example/legacy.jpg',
      mime: 'image/jpeg',
    });
    expect(referenceStill({ outputs: [video, audio, sprite], posterUrl: 'https://cdn.example/legacy.jpg' })).toEqual({
      url: 'https://cdn.example/legacy.jpg',
      mime: 'image/jpeg',
    });
  });

  it('只有 thumbnail 时用它', () => {
    expect(
      referenceStill({
        outputs: [video, { kind: 'thumbnail', url: 'https://cdn.example/thumb.webp', mime: 'image/webp' }],
        posterUrl: null,
      }),
    ).toEqual({ url: 'https://cdn.example/thumb.webp', mime: 'image/webp' });
  });

  it('什么都没有返回 null', () => {
    expect(referenceStill({ outputs: [], posterUrl: null })).toBeNull();
    expect(referenceStill({ outputs: [], posterUrl: '' })).toBeNull();
    expect(
      referenceStill({
        outputs: [
          { kind: 'image', url: '', mime: 'image/png' },
          { kind: 'poster', url: '', mime: 'image/jpeg' },
          { kind: 'thumbnail', url: '', mime: 'image/webp' },
        ],
        posterUrl: null,
      }),
    ).toBeNull();
  });
});
