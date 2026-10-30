import { describe, expect, it } from 'vitest';
import { GENERATION_LIST_TYPE_INVALID, generationListType } from '../src/lib/generation-list-type.js';

describe('generationListType', () => {
  it('空', () => {
    expect(generationListType({})).toEqual({ type: null, error: null });
    expect(generationListType({ type: undefined })).toEqual({ type: null, error: null });
    expect(generationListType({ type: null })).toEqual({ type: null, error: null });
    expect(generationListType({ type: '' })).toEqual({ type: null, error: null });
  });

  it('image', () => {
    expect(generationListType({ type: 'image' })).toEqual({ type: 'image', error: null });
  });

  it('video', () => {
    expect(generationListType({ type: 'video' })).toEqual({ type: 'video', error: null });
  });

  it('audio', () => {
    expect(generationListType({ type: 'audio' })).toEqual({ type: null, error: GENERATION_LIST_TYPE_INVALID });
    expect(GENERATION_LIST_TYPE_INVALID).toBe('任务种类无效');
  });

  it('数组', () => {
    expect(generationListType({ type: ['image'] })).toEqual({ type: null, error: GENERATION_LIST_TYPE_INVALID });
    expect(generationListType({ type: ['video', 'image'] })).toEqual({ type: null, error: GENERATION_LIST_TYPE_INVALID });
    expect(generationListType({ type: [] })).toEqual({ type: null, error: GENERATION_LIST_TYPE_INVALID });
  });
});
