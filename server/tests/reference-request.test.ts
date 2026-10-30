import { describe, expect, it } from 'vitest';
import { missingReferenceMessage } from '../src/lib/reference-request.js';

const missing = '参考素材不存在或无权使用';

describe('missingReferenceMessage', () => {
  it('全部找到', () => {
    expect(missingReferenceMessage(['a', 'b'], ['b', 'a'])).toBeNull();
  });

  it('缺一个', () => {
    expect(missingReferenceMessage(['a', 'b'], ['a'])).toBe(missing);
  });

  it('空白编号', () => {
    expect(missingReferenceMessage(['  a  ', '\tb\n'], ['a', 'b'])).toBeNull();
    expect(missingReferenceMessage(['  a  ', '  '], ['a'])).toBe(missing);
    expect(missingReferenceMessage(['   '], [])).toBe(missing);
  });

  it('重复的已有编号', () => {
    expect(missingReferenceMessage(['a', 'a', ' a '], ['a'])).toBeNull();
  });

  it('空数组', () => {
    expect(missingReferenceMessage([], [])).toBeNull();
    expect(missingReferenceMessage([], ['a'])).toBeNull();
  });
});
