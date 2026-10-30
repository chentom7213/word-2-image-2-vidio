import { describe, expect, it } from 'vitest';
import { cursorStamp, generationCursorSql, parseGenerationPage } from '../src/services/generation-page.js';
import { appendGenerationPage, mergeGenerationPage } from '../../src/lib/history-page.ts';

describe('generation history pages', () => {
  it('keeps the old 200 row cap when the client does not ask for a page', () => {
    expect(parseGenerationPage({})).toEqual({ limit: 200, cursor: null, error: null });
    expect(parseGenerationPage({ limit: '50' }).limit).toBe(50);
    expect(parseGenerationPage({ limit: '500' }).limit).toBe(200);
    expect(parseGenerationPage({ before: 'not-a-time', beforeId: 'task-1' }).error).toBe('历史游标无效');
  });

  it('turns a cursor into a stable older-than predicate', () => {
    const page = parseGenerationPage({
      limit: '50',
      before: '2026-10-26 11:14:02.123',
      beforeId: 'task-9',
    });
    expect(page.error).toBeNull();
    expect(generationCursorSql(page.cursor)).toEqual({
      sql: 'AND (created_at < ? OR (created_at = ? AND id < ?))',
      params: ['2026-10-26 11:14:02.123', '2026-10-26 11:14:02.123', 'task-9'],
    });
    expect(cursorStamp(new Date('2026-10-26T11:14:02.123Z'))).toBe('2026-10-26 11:14:02.123');
  });

  it('keeps older loaded rows when the newest page is refreshed', () => {
    const older = [
      { id: 'b', createdAt: 2000 },
      { id: 'a', createdAt: 1000 },
    ];
    const first = [{ id: 'c', createdAt: 3000 }];
    expect(mergeGenerationPage(older, first, 1)).toEqual([
      { id: 'c', createdAt: 3000 },
      { id: 'b', createdAt: 2000 },
      { id: 'a', createdAt: 1000 },
    ]);
    expect(mergeGenerationPage(older, first, 2)).toEqual(first);
    expect(appendGenerationPage(first, [...first, { id: 'b', createdAt: 2000 }])).toEqual([
      { id: 'c', createdAt: 3000 },
      { id: 'b', createdAt: 2000 },
    ]);
  });
});
