import { describe, expect, it } from 'vitest';
import {
  generationFingerprint,
  releaseSubmitKey,
  takeSubmitKey,
} from '../../src/lib/submit-key.ts';

const form = {
  type: 'video' as const,
  prompt: '一只猫',
  modelId: 'builtin-video',
  resolution: '720p',
  width: 1280,
  height: 720,
  duration: 4,
  count: 1,
  visibility: 'private' as const,
  refIds: ['b', 'a'],
};

describe('generation submit key', () => {
  it('reuses the key while the same form has not succeeded', () => {
    const fingerprint = generationFingerprint(form);
    const first = takeSubmitKey(null, fingerprint, 'gen-1');
    const second = takeSubmitKey(first.pending, fingerprint, 'gen-2');
    expect(second.key).toBe('gen-1');
    expect(generationFingerprint({ ...form, refIds: ['a', 'b'] })).toBe(fingerprint);
  });

  it('changes the key when the prompt changes and after success', () => {
    const fingerprint = generationFingerprint(form);
    const first = takeSubmitKey(null, fingerprint, 'gen-1');
    const edited = generationFingerprint({ ...form, prompt: '一只狗' });
    const next = takeSubmitKey(first.pending, edited, 'gen-2');
    expect(next.key).toBe('gen-2');
    expect(releaseSubmitKey(next.pending, fingerprint, 'gen-1')).toBe(next.pending);
    expect(releaseSubmitKey(next.pending, edited, 'gen-2')).toBeNull();
  });
});
