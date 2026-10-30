import { describe, expect, it } from 'vitest';
import { contentTypeForObjectKey, outputExtension } from '../src/lib/output-extension.js';

describe('outputExtension', () => {
  it('对上的类型用对应扩展名', () => {
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

  it('去掉 video/mp4 分号后的参数', () => {
    expect(outputExtension('video/mp4; codecs="avc1.42E01E"', 'video')).toBe('mp4');
  });

  it('大写 Video/MP4 仍是 mp4', () => {
    expect(outputExtension('Video/MP4', 'video')).toBe('mp4');
  });

  it('未知视频用 mp4', () => {
    expect(outputExtension('video/ogg', 'video')).toBe('mp4');
    expect(outputExtension('application/octet-stream', 'video')).toBe('mp4');
  });

  it('普通图片用 png', () => {
    expect(outputExtension('image/bmp', 'image')).toBe('png');
    expect(outputExtension('image/png', 'image')).toBe('png');
  });

  it('空类型用 png', () => {
    expect(outputExtension('', 'image')).toBe('png');
    expect(outputExtension('   ; charset=utf-8', 'poster')).toBe('png');
  });
});

describe('contentTypeForObjectKey', () => {
  it('按扩展名给出类型', () => {
    expect(contentTypeForObjectKey('a.png')).toBe('image/png');
    expect(contentTypeForObjectKey('dir/a.PNG')).toBe('image/png');
    expect(contentTypeForObjectKey('a.jpg')).toBe('image/jpeg');
    expect(contentTypeForObjectKey('a.jpeg')).toBe('image/jpeg');
    expect(contentTypeForObjectKey('a.webp')).toBe('image/webp');
    expect(contentTypeForObjectKey('a.gif')).toBe('image/gif');
    expect(contentTypeForObjectKey('a.bmp')).toBe('image/bmp');
    expect(contentTypeForObjectKey('a.AVIF')).toBe('image/avif');
    expect(contentTypeForObjectKey('a.mp4')).toBe('video/mp4');
    expect(contentTypeForObjectKey('a.webm')).toBe('video/webm');
    expect(contentTypeForObjectKey('a.mov')).toBe('video/quicktime');
    expect(contentTypeForObjectKey('a.m4v')).toBe('video/mp4');
    expect(contentTypeForObjectKey('a.mkv')).toBe('video/x-matroska');
    expect(contentTypeForObjectKey('a.avi')).toBe('video/x-msvideo');
    expect(contentTypeForObjectKey('a.mp3')).toBe('audio/mpeg');
    expect(contentTypeForObjectKey('a.wav')).toBe('audio/wav');
    expect(contentTypeForObjectKey('a.ogg')).toBe('audio/ogg');
    expect(contentTypeForObjectKey('a.m4a')).toBe('audio/mp4');
    expect(contentTypeForObjectKey('a.aac')).toBe('audio/aac');
    expect(contentTypeForObjectKey('a.flac')).toBe('audio/flac');
  });

  it('没有扩展名或对不上时不给类型', () => {
    expect(contentTypeForObjectKey('noext')).toBeNull();
    expect(contentTypeForObjectKey('dir/file')).toBeNull();
    expect(contentTypeForObjectKey('a.txt')).toBeNull();
    expect(contentTypeForObjectKey('.png')).toBeNull();
  });
});
