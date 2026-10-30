// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import {
  DELETE_STILL_RUNNING,
  deleteRefusalMessage,
  mergeGenerationsAfterDelete,
  ownsGeneration,
  visibleGenerationsAfterDelete,
} from './delete-result.ts';

describe('visibleGenerationsAfterDelete', () => {
  it('keeps the original list while a task is still running', () => {
    const snapshot = [{ id: 'running' }, { id: 'done' }];
    expect(visibleGenerationsAfterDelete(snapshot, ['running'], { ok: false })).toBe(snapshot);
  });

  it('drops only the ids in deletedIds', () => {
    const snapshot = [{ id: 'running' }, { id: 'done' }, { id: 'failed' }];
    expect(
      visibleGenerationsAfterDelete(snapshot, ['running', 'done', 'failed'], {
        ok: true,
        deletedIds: ['done', 'failed'],
      }),
    ).toEqual([{ id: 'running' }]);
    expect(snapshot.map((item) => item.id)).toEqual(['running', 'done', 'failed']);
  });

  it('drops every requested id when an older response has no deletedIds', () => {
    const snapshot = [{ id: 'done' }, { id: 'failed' }, { id: 'other' }];
    expect(visibleGenerationsAfterDelete(snapshot, ['done', 'failed'], { ok: true })).toEqual([{ id: 'other' }]);
  });
});

describe('ownsGeneration', () => {
  it('is true when mine is missing', () => {
    expect(ownsGeneration({})).toBe(true);
  });

  it('is true when mine is not false', () => {
    expect(ownsGeneration({ mine: true })).toBe(true);
  });

  it('is false when mine is false', () => {
    expect(ownsGeneration({ mine: false })).toBe(false);
  });
});

describe('deleteRefusalMessage', () => {
  it('returns null when nothing remains', () => {
    expect(deleteRefusalMessage([])).toBeNull();
  });

  it('names someone else’s task when any remaining task is not theirs', () => {
    expect(deleteRefusalMessage([{ mine: false }])).toBe('只能删除自己的任务');
    expect(deleteRefusalMessage([{ mine: true }, { mine: false }])).toBe('只能删除自己的任务');
    expect(deleteRefusalMessage([{}, { mine: false }])).toBe('只能删除自己的任务');
  });

  it('keeps the running message when every remaining task belongs to the caller', () => {
    expect(deleteRefusalMessage([{ mine: true }])).toBe(DELETE_STILL_RUNNING);
    expect(deleteRefusalMessage([{}])).toBe(DELETE_STILL_RUNNING);
  });
});

describe('mergeGenerationsAfterDelete', () => {
  it('keeps a row that arrived during the request and restores one that was not deleted', () => {
    const snapshot = [{ id: 'running' }, { id: 'done' }];
    const current = [{ id: 'fresh' }, { id: 'done' }];
    expect(
      mergeGenerationsAfterDelete(snapshot, current, ['running', 'done'], {
        ok: true,
        deletedIds: ['done'],
      }),
    ).toEqual([{ id: 'fresh' }, { id: 'running' }]);
  });
});
