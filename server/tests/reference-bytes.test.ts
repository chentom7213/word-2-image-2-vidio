import { describe, expect, it } from 'vitest';
import { referenceByteMessage } from '../src/lib/reference-bytes.js';

const AUDIO_MAX_BYTES = 15 * 1024 * 1024;
const MEDIA_MAX_BYTES = 50 * 1024 * 1024;

const AUDIO_TOO_LARGE = '参考音频不能超过 15MB';
const VIDEO_TOO_LARGE = '参考视频不能超过 50MB';
const IMAGE_TOO_LARGE = '参考图不能超过 50MB';

describe('referenceByteMessage', () => {
  it('音频超过', () => {
    expect(referenceByteMessage([{ kind: 'audio', size: AUDIO_MAX_BYTES + 1 }])).toBe(AUDIO_TOO_LARGE);
  });

  it('音频刚好', () => {
    expect(referenceByteMessage([{ kind: 'audio', size: AUDIO_MAX_BYTES }])).toBeNull();
    expect(referenceByteMessage([{ kind: 'audio', size: AUDIO_MAX_BYTES - 1 }])).toBeNull();
  });

  it('视频超过', () => {
    expect(referenceByteMessage([{ kind: 'video', size: MEDIA_MAX_BYTES + 1 }])).toBe(VIDEO_TOO_LARGE);
  });

  it('图片刚好', () => {
    expect(referenceByteMessage([{ kind: 'image', size: MEDIA_MAX_BYTES }])).toBeNull();
    expect(referenceByteMessage([{ kind: 'image', size: MEDIA_MAX_BYTES - 1 }])).toBeNull();
  });

  it('空数组', () => {
    expect(referenceByteMessage([])).toBeNull();
  });

  it('先遇到的那一条', () => {
    expect(referenceByteMessage([
      { kind: 'image', size: MEDIA_MAX_BYTES },
      { kind: 'audio', size: Number.POSITIVE_INFINITY },
      { kind: 'audio', size: AUDIO_MAX_BYTES + 1 },
      { kind: 'video', size: MEDIA_MAX_BYTES + 1 },
    ])).toBe(AUDIO_TOO_LARGE);

    expect(referenceByteMessage([
      { kind: 'video', size: MEDIA_MAX_BYTES + 1 },
      { kind: 'audio', size: AUDIO_MAX_BYTES + 1 },
      { kind: 'image', size: MEDIA_MAX_BYTES + 1 },
    ])).toBe(VIDEO_TOO_LARGE);

    expect(referenceByteMessage([
      { kind: 'audio', size: Number.NaN },
      { kind: 'image', size: MEDIA_MAX_BYTES + 1 },
      { kind: 'video', size: MEDIA_MAX_BYTES + 1 },
    ])).toBe(IMAGE_TOO_LARGE);
  });
});
