/** One canvas asset page. Matches the asset list maximum. */
export const CANVAS_ASSET_PAGE_LIMIT = 200;

const MAX_CANVAS_ASSET_PAGES = 20;

export type CanvasAssetCursor = { createdAt: string; id: string };

export type CanvasAssetPage<T extends { id: string }> = {
  items: readonly T[];
  nextCursor: CanvasAssetCursor | null;
};

/**
 * Walks a cursor until every needed id has appeared, the next cursor is absent, or 20 pages are read.
 * The first page is always read; an empty id list stops there. Duplicate ids are kept once, first seen first.
 * When the walk stops because every needed id is present, or after 20 pages, the last page's cursor is returned
 * if that page still has one. A page with no next cursor returns null.
 */
export async function loadCanvasKind<T extends { id: string }>(
  neededIds: readonly string[],
  fetchPage: (cursor: CanvasAssetCursor | null) => Promise<CanvasAssetPage<T>>,
): Promise<CanvasAssetPage<T>> {
  const missing = new Set(neededIds);
  const seen = new Set<string>();
  const items: T[] = [];
  let cursor: CanvasAssetCursor | null = null;
  let nextCursor: CanvasAssetCursor | null = null;

  for (let pageIndex = 0; pageIndex < MAX_CANVAS_ASSET_PAGES; pageIndex += 1) {
    const page = await fetchPage(cursor);
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
      missing.delete(item.id);
    }
    nextCursor = page.nextCursor;
    if (missing.size === 0 || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return { items, nextCursor };
}
