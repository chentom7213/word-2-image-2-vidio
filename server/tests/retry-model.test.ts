import { describe, expect, it } from 'vitest';
import { retryModelProblem, type ModelDto } from '../src/services/models.js';

function model(overrides: Partial<ModelDto> = {}): ModelDto {
  return {
    id: 'v',
    name: 'Video',
    kind: 'video',
    priceLabel: '55积分/秒',
    priceAmount: 55,
    priceUnit: 'per_second',
    tag: null,
    refs: ['image'],
    durations: [3, 5, 10],
    provider: 'x',
    providerModel: 'v',
    maxDuration: 10,
    ...overrides,
  };
}

describe('retryModelProblem', () => {
  it('rejects a video reference when the model only supports images', () => {
    expect(
      retryModelProblem(model(), { type: 'video', duration: 5, count: 1, refKinds: ['video'] }),
    ).toBe('该模型不支持参考视频');
  });

  it('rejects a duration over the model maximum', () => {
    expect(retryModelProblem(model(), { type: 'video', duration: 11, count: 1 })).toContain('最长支持');
  });

  it('rejects a task whose type does not match the model', () => {
    expect(retryModelProblem(model({ kind: 'image' }), { type: 'video', duration: 5, count: 1 })).toBe(
      '模型类型与任务类型不匹配',
    );
  });

  it('accepts an image reference within the duration limit', () => {
    expect(
      retryModelProblem(model(), { type: 'video', duration: 5, count: 1, refKinds: ['image'] }),
    ).toBeNull();
  });
});
