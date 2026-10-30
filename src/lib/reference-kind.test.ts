// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { referenceKindVisible } from './reference-kind.ts';

describe('referenceKindVisible', () => {
  it('shows every kind when signed out, even if refs is empty', () => {
    expect(referenceKindVisible(false, [], 'image')).toBe(true);
    expect(referenceKindVisible(false, [], 'video')).toBe(true);
    expect(referenceKindVisible(false, [], 'audio')).toBe(true);
    expect(referenceKindVisible(false, undefined, 'image')).toBe(true);
  });

  it('hides video and audio when signed in and only image is supported', () => {
    expect(referenceKindVisible(true, ['image'], 'image')).toBe(true);
    expect(referenceKindVisible(true, ['image'], 'video')).toBe(false);
    expect(referenceKindVisible(true, ['image'], 'audio')).toBe(false);
  });

  it('hides every kind when signed in and refs is missing', () => {
    expect(referenceKindVisible(true, undefined, 'image')).toBe(false);
    expect(referenceKindVisible(true, undefined, 'video')).toBe(false);
    expect(referenceKindVisible(true, undefined, 'audio')).toBe(false);
    expect(referenceKindVisible(true, null, 'image')).toBe(false);
  });
});
