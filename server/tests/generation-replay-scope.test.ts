import { describe, expect, it } from 'vitest';
import { replayTaskScope } from '../src/lib/generation-replay-scope.js';

const DENIED = 'API Key 缺少所需权限';

describe('replayTaskScope', () => {
  it('网页登录没有 scope 时，image 和 video 都放行', () => {
    expect(replayTaskScope(undefined, 'image')).toBeNull();
    expect(replayTaskScope(undefined, 'video')).toBeNull();
  });

  it('* 放行', () => {
    expect(replayTaskScope(['*'], 'image')).toBeNull();
    expect(replayTaskScope(['*'], 'video')).toBeNull();
  });

  it('只有 generate:image 时能重放图片，不能重放视频', () => {
    expect(replayTaskScope(['generate:image'], 'image')).toBeNull();
    expect(replayTaskScope(['generate:image'], 'video')).toBe(DENIED);
  });

  it('只有 generate:video 时能重放视频，不能重放图片', () => {
    expect(replayTaskScope(['generate:video'], 'video')).toBeNull();
    expect(replayTaskScope(['generate:video'], 'image')).toBe(DENIED);
  });

  it('两种权限都有时，image 和 video 都放行', () => {
    const scopes = ['generate:image', 'generate:video'];
    expect(replayTaskScope(scopes, 'image')).toBeNull();
    expect(replayTaskScope(scopes, 'video')).toBeNull();
  });

  it('空 scope 列表不能重放图片', () => {
    expect(replayTaskScope([], 'image')).toBe(DENIED);
  });

  it('不是 image 或 video 的种类，有限 scope 拒绝，没有 scope 放行', () => {
    expect(replayTaskScope(['generate:image'], 'audio')).toBe(DENIED);
    expect(replayTaskScope(undefined, 'audio')).toBeNull();
  });
});
