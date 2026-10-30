import { describe, expect, it } from 'vitest';
import { ASSET_LIST_KIND_INVALID, parseAssetListKind } from '../src/lib/asset-list-kind.js';

describe('parseAssetListKind', () => {
  it('空', () => {
    expect(parseAssetListKind({})).toEqual({ kind: null, error: null });
    expect(parseAssetListKind({ kind: null })).toEqual({ kind: null, error: null });
    expect(parseAssetListKind({ kind: '' })).toEqual({ kind: null, error: null });
  });

  it('image', () => {
    expect(parseAssetListKind({ kind: 'image' })).toEqual({ kind: 'image', error: null });
  });

  it('video', () => {
    expect(parseAssetListKind({ kind: 'video' })).toEqual({ kind: 'video', error: null });
  });

  it('audio', () => {
    expect(parseAssetListKind({ kind: 'audio' })).toEqual({ kind: 'audio', error: null });
  });

  it('sprite', () => {
    expect(parseAssetListKind({ kind: 'sprite' })).toEqual({ kind: null, error: ASSET_LIST_KIND_INVALID });
  });

  it('数组', () => {
    expect(parseAssetListKind({ kind: ['image'] })).toEqual({ kind: null, error: ASSET_LIST_KIND_INVALID });
  });
});
