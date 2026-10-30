import { describe, expect, it } from 'vitest';
import { storedMime } from '../src/lib/stored-mime.js';

describe('storedMime', () => {
  it('短的小写类型保持原样', () => {
    expect(storedMime('image/png', 120)).toBe('image/png');
    expect(storedMime('video/mp4', 80)).toBe('video/mp4');
  });

  it('去掉参数并转成小写', () => {
    expect(storedMime('Video/MP4; codecs="avc1.42E01E"', 120)).toBe('video/mp4');
  });

  it('超过列宽时截断', () => {
    expect(storedMime(`image/${'x'.repeat(200)}`, 80)).toHaveLength(80);
    expect(storedMime(`image/${'x'.repeat(200)}`, 120)).toHaveLength(120);
  });

  it('空值返回 null', () => {
    expect(storedMime('', 120)).toBeNull();
    expect(storedMime('   ; charset=utf-8', 120)).toBeNull();
    expect(storedMime(null, 80)).toBeNull();
  });
});
