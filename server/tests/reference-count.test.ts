import { describe, expect, it } from 'vitest';
import { retryModelProblem, validateAgainstModel, type ModelDto } from '../src/services/models.js';

function model(overrides: Partial<ModelDto> = {}): ModelDto {
  return {
    id: 'm',
    name: 'Model',
    kind: 'image',
    priceLabel: '25积分/张',
    priceAmount: 25,
    priceUnit: 'per_image',
    tag: null,
    refs: ['image', 'video', 'audio'],
    durations: [],
    provider: 'x',
    providerModel: 'm',
    maxDuration: null,
    ...overrides,
  };
}

function refs(image: number, video = 0, audio = 0): Array<'image' | 'video' | 'audio'> {
  return [
    ...Array<'image'>(image).fill('image'),
    ...Array<'video'>(video).fill('video'),
    ...Array<'audio'>(audio).fill('audio'),
  ];
}

const base = { duration: 0, count: 1 };

describe('validateAgainstModel reference counts', () => {
  it('rejects more than 9 reference images', () => {
    expect(validateAgainstModel(model(), { ...base, refCount: 10, refKinds: refs(10) })).toBe('参考图最多 9 张');
  });

  it('rejects more than 3 reference videos', () => {
    expect(validateAgainstModel(model(), { ...base, refCount: 4, refKinds: refs(0, 4) })).toBe('参考视频最多 3 个');
  });

  it('rejects more than 3 reference audios', () => {
    expect(validateAgainstModel(model(), { ...base, refCount: 4, refKinds: refs(0, 0, 4) })).toBe(
      '参考音频最多 3 个',
    );
  });

  it('accepts exactly 9 images, 3 videos, and 3 audios', () => {
    expect(validateAgainstModel(model(), { ...base, refCount: 9, refKinds: refs(9) })).toBeNull();
    expect(validateAgainstModel(model(), { ...base, refCount: 3, refKinds: refs(0, 3) })).toBeNull();
    expect(validateAgainstModel(model(), { ...base, refCount: 3, refKinds: refs(0, 0, 3) })).toBeNull();
    const refKinds = refs(9, 3, 3);
    expect(validateAgainstModel(model(), { ...base, refCount: refKinds.length, refKinds })).toBeNull();
  });

  it('keeps the unsupported-kind check ahead of the count check', () => {
    expect(
      validateAgainstModel(model({ refs: [] }), { ...base, refCount: 10, refKinds: refs(10) }),
    ).toBe('该模型不支持参考图');
    expect(
      validateAgainstModel(model({ refs: ['image'] }), {
        ...base,
        refCount: 11,
        refKinds: [...refs(10), 'video'],
      }),
    ).toBe('该模型不支持参考视频');
  });

  it('keeps the original refCount rule when refKinds is omitted', () => {
    expect(validateAgainstModel(model({ refs: [] }), { ...base, refCount: 10 })).toBe('该模型不支持参考素材');
    expect(validateAgainstModel(model(), { ...base, refCount: 10 })).toBeNull();
    expect(validateAgainstModel(model({ refs: [] }), { ...base, refCount: 0 })).toBeNull();
  });

  it('returns the same count limits from a retry', () => {
    const task = { type: 'image' as const, duration: 0, count: 1 };
    expect(retryModelProblem(model(), { ...task, refKinds: refs(10) })).toBe('参考图最多 9 张');
    expect(retryModelProblem(model(), { ...task, refKinds: refs(0, 4) })).toBe('参考视频最多 3 个');
    expect(retryModelProblem(model(), { ...task, refKinds: refs(0, 0, 4) })).toBe('参考音频最多 3 个');
    expect(retryModelProblem(model(), { ...task, refKinds: refs(9, 3, 3) })).toBeNull();
    expect(retryModelProblem(model({ refs: [] }), { ...task })).toBeNull();
  });
});
