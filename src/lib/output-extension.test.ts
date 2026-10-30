// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { outputExtension } from './output-extension.ts';

describe('outputExtension', () => {
  it('maps known mime types', () => {
    expect(outputExtension('image/png', 'image')).toBe('png');
    expect(outputExtension('image/jpeg', 'image')).toBe('jpg');
    expect(outputExtension('image/jpg', 'image')).toBe('jpg');
    expect(outputExtension('image/webp', 'image')).toBe('webp');
    expect(outputExtension('image/gif', 'image')).toBe('gif');
    expect(outputExtension('video/mp4', 'video')).toBe('mp4');
    expect(outputExtension('video/webm', 'video')).toBe('webm');
    expect(outputExtension('video/quicktime', 'video')).toBe('mov');
    expect(outputExtension('audio/mpeg', 'audio')).toBe('mp3');
    expect(outputExtension('audio/wav', 'audio')).toBe('wav');
  });

  it('strips parameters, then trims and lowercases video/mp4', () => {
    expect(outputExtension('video/mp4; codecs="avc1.42E01E"', 'video')).toBe('mp4');
    expect(outputExtension(' Video/MP4; codecs="avc1.42E01E" ', 'image')).toBe('mp4');
  });

  it('uses mp4 for an unmatched video mime or a video kind', () => {
    expect(outputExtension('video/ogg', 'image')).toBe('mp4');
    expect(outputExtension('application/octet-stream', 'video')).toBe('mp4');
  });

  it('uses png for every other mime', () => {
    expect(outputExtension('image/png', 'video')).toBe('png');
    expect(outputExtension('application/octet-stream', 'image')).toBe('png');
    expect(outputExtension('', 'poster')).toBe('png');
  });
});
