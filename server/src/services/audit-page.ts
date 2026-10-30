/** Audit rows are ordered by `id DESC`. The cursor is that id, not a timestamp. */
export function auditBeforeId(before: string | undefined): { id: string } | { error: string } | null {
  if (!before) return null;
  if (!/^[1-9]\d{0,18}$/.test(before)) return { error: '审计游标无效' };
  return { id: before };
}
