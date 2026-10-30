import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import { assertCanGenerate } from '../src/routes/generations.js';

describe('generate role gate', () => {
  it('rejects a viewer before a generation is created', () => {
    expect(() => assertCanGenerate('viewer')).toThrow(ApiError);
    try {
      assertCanGenerate('viewer');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(403);
      expect((err as ApiError).message).toBe('只读成员无法创建生成任务');
    }
  });

  it.each(['owner', 'admin', 'editor', undefined])('lets %s continue', (role) => {
    expect(() => assertCanGenerate(role)).not.toThrow();
  });
});
