import { describe, expect, it } from 'vitest';
import { generationFieldMessage } from '../src/lib/generation-field.js';

describe('generationFieldMessage', () => {
  it('type 返回任务种类无效', () => {
    expect(generationFieldMessage('type')).toBe('任务种类无效');
  });

  it('duration 返回时长需为 0 到 120 的整数', () => {
    expect(generationFieldMessage('duration')).toBe('时长需为 0 到 120 的整数');
  });

  it('count 返回生成数量需在 1~8 之间', () => {
    expect(generationFieldMessage('count')).toBe('生成数量需在 1~8 之间');
  });

  it('visibility 返回可见性无效', () => {
    expect(generationFieldMessage('visibility')).toBe('可见性无效');
  });

  it('undefined、prompt、width 返回 null', () => {
    expect(generationFieldMessage(undefined)).toBeNull();
    expect(generationFieldMessage('prompt')).toBeNull();
    expect(generationFieldMessage('width')).toBeNull();
  });
});
