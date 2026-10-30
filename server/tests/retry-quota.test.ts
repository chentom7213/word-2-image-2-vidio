import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import { assertVideoPlanDuration } from '../src/routes/generations.js';
import { activeTaskCountQuery } from '../src/services/plans.js';

describe('activeTaskCountQuery', () => {
  it('counts only the user when no task is excluded', () => {
    const userId = 'user-1';
    const { sql, params } = activeTaskCountQuery(userId);
    expect(params).toEqual([userId]);
    expect(sql).not.toContain('id <>');
  });

  it('excludes the given task id', () => {
    const userId = 'user-1';
    const id = 'task-9';
    const { sql, params } = activeTaskCountQuery(userId, id);
    expect(params).toEqual([userId, id]);
    expect(sql).toContain('AND id <> ?');
  });
});

describe('assertVideoPlanDuration', () => {
  it('rejects a video longer than the plan allows', () => {
    const message = '当前套餐最长支持 5 秒视频，请升级套餐或缩短时长';
    expect(() => assertVideoPlanDuration('video', 6, 5)).toThrow(ApiError);
    try {
      assertVideoPlanDuration('video', 6, 5);
    } catch (err) {
      expect((err as ApiError).message).toBe(message);
    }
  });

  it('allows an image and a video within the plan limit', () => {
    expect(() => assertVideoPlanDuration('image', 30, 5)).not.toThrow();
    expect(() => assertVideoPlanDuration('video', 5, 5)).not.toThrow();
  });
});
