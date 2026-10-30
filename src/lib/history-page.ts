export const HISTORY_PAGE_SIZE = 50;

export type HistoryCursor = { createdAt: string; id: string };

type HistoryItem = { id: string; createdAt?: number };

/**
 * A short first page is the whole history. A full page keeps already loaded
 * rows that are older than its last item, so the 8s refresh does not drop them.
 */
export function mergeGenerationPage<T extends HistoryItem>(loaded: T[], firstPage: T[], pageSize: number): T[] {
  if (firstPage.length < pageSize) return firstPage;
  const seen = new Set(firstPage.map((item) => item.id));
  const oldest = firstPage[firstPage.length - 1];
  const oldestAt = oldest.createdAt ?? 0;
  const older = loaded.filter((item) => {
    if (seen.has(item.id)) return false;
    const at = item.createdAt ?? 0;
    if (at < oldestAt) return true;
    if (at > oldestAt) return false;
    return item.id < oldest.id;
  });
  return [...firstPage, ...older];
}

export function appendGenerationPage<T extends HistoryItem>(loaded: T[], nextPage: T[]): T[] {
  const seen = new Set(loaded.map((item) => item.id));
  return [...loaded, ...nextPage.filter((item) => !seen.has(item.id))];
}
