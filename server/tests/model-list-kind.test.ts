import { describe, expect, it } from 'vitest';
import { MODEL_LIST_KIND_INVALID, modelListKind } from '../src/lib/model-list-kind.js';

describe('modelListKind', () => {
  it('空', () => {
    expect(modelListKind({})).toEqual({ kind: null, error: null });
    expect(modelListKind({ kind: undefined })).toEqual({ kind: null, error: null });
    expect(modelListKind({ kind: null })).toEqual({ kind: null, error: null });
    expect(modelListKind({ kind: '' })).toEqual({ kind: null, error: null });
  });

  it('image', () => {
    expect(modelListKind({ kind: 'image' })).toEqual({ kind: 'image', error: null });
  });

  it('video', () => {
    expect(modelListKind({ kind: 'video' })).toEqual({ kind: 'video', error: null });
  });

  it('audio', () => {
    expect(modelListKind({ kind: 'audio' })).toEqual({ kind: null, error: MODEL_LIST_KIND_INVALID });
    expect(MODEL_LIST_KIND_INVALID).toBe('模型种类无效');
  });

  it('数组', () => {
    expect(modelListKind({ kind: ['image'] })).toEqual({ kind: null, error: MODEL_LIST_KIND_INVALID });
    expect(modelListKind({ kind: [] })).toEqual({ kind: null, error: MODEL_LIST_KIND_INVALID });
  });
});
