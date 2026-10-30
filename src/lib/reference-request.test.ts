// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { unuploadedReferenceMessage } from './reference-request.ts';

const PENDING = '参考素材还没上传到素材库';

describe('unuploadedReferenceMessage', () => {
  it('rejects a blob preview', () => {
    expect(unuploadedReferenceMessage([{ id: 'asset-1', url: 'blob:http://localhost/preview' }])).toBe(PENDING);
  });

  it('rejects a data url', () => {
    expect(unuploadedReferenceMessage([{ id: 'asset-1', url: 'data:image/png;base64,abc' }])).toBe(PENDING);
  });

  it('rejects an empty id', () => {
    expect(unuploadedReferenceMessage([{ id: '', url: '/library/a.png' }])).toBe(PENDING);
    expect(unuploadedReferenceMessage([{ id: '   ', url: '/library/a.png' }])).toBe(PENDING);
  });

  it('accepts uploaded relative and https addresses', () => {
    expect(
      unuploadedReferenceMessage([
        { id: 'asset-1', url: '/library/a.png' },
        { id: 'asset-2', url: 'https://cdn.example/b.mp4' },
      ]),
    ).toBeNull();
    expect(unuploadedReferenceMessage([])).toBeNull();
  });

  it('rejects a mix of uploaded assets and a local preview', () => {
    expect(
      unuploadedReferenceMessage([
        { id: 'asset-1', url: 'https://cdn.example/a.png' },
        { id: 'asset-2', url: 'blob:http://localhost/preview' },
      ]),
    ).toBe(PENDING);
  });
});
