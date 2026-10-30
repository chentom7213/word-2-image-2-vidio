const CURSOR_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;
const CURSOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const GENERATION_PAGE_DEFAULT = 200;
export const GENERATION_PAGE_MAX = 200;

export type GenerationCursor = { createdAt: string; id: string };

export function parseGenerationPage(query: { limit?: unknown; before?: unknown; beforeId?: unknown }): {
  limit: number;
  cursor: GenerationCursor | null;
  error: string | null;
} {
  const limit = pageLimit(query.limit);
  const before = typeof query.before === 'string' ? query.before.trim() : '';
  const beforeId = typeof query.beforeId === 'string' ? query.beforeId.trim() : '';
  if (!before && !beforeId) return { limit, cursor: null, error: null };
  if (!CURSOR_TIME.test(before) || !CURSOR_ID.test(beforeId)) {
    return { limit, cursor: null, error: '历史游标无效' };
  }
  return { limit, cursor: { createdAt: before, id: beforeId }, error: null };
}

export function generationCursorSql(cursor: GenerationCursor | null): { sql: string; params: string[] } {
  if (!cursor) return { sql: '', params: [] };
  return {
    sql: 'AND (created_at < ? OR (created_at = ? AND id < ?))',
    params: [cursor.createdAt, cursor.createdAt, cursor.id],
  };
}

export function cursorStamp(value: unknown): string | null {
  if (typeof value === 'string' && CURSOR_TIME.test(value.trim())) return value.trim();
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().replace('T', ' ').replace('Z', '');
  }
  return null;
}

function pageLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return GENERATION_PAGE_DEFAULT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > GENERATION_PAGE_MAX) return GENERATION_PAGE_DEFAULT;
  return value;
}
