/** Shown when a requested task is still in the list after delete. */
export const DELETE_STILL_RUNNING = '任务进行中，请先取消再删除';

const DELETE_NOT_OWN = '只能删除自己的任务';

/** Missing mine, or any value other than false, means this caller owns the task. */
export function ownsGeneration(item: { mine?: boolean }): boolean {
  return item.mine !== false;
}

/** Why a delete must stop. Null when every requested task is gone. */
export function deleteRefusalMessage(remaining: Array<{ mine?: boolean }>): string | null {
  if (remaining.length === 0) return null;
  if (remaining.some((item) => item.mine === false)) return DELETE_NOT_OWN;
  return DELETE_STILL_RUNNING;
}

/** ok false keeps the snapshot. deletedIds removes only those ids; without it, every requested id goes. */
export function visibleGenerationsAfterDelete<T extends { id: string }>(
  snapshot: T[],
  requestedIds: string[],
  result: { ok: boolean; deletedIds?: string[] },
): T[] {
  if (!result.ok) return snapshot;
  const removed = new Set(result.deletedIds ?? requestedIds);
  return snapshot.filter((item) => !removed.has(item.id));
}

/**
 * Applies the delete result onto the list as it is now.
 * Rows that arrived while the request was in flight stay.
 * A requested row stays only when the result kept it.
 */
export function mergeGenerationsAfterDelete<T extends { id: string }>(
  snapshot: T[],
  current: T[],
  requestedIds: string[],
  result: { ok: boolean; deletedIds?: string[] },
): T[] {
  const keptIds = new Set(visibleGenerationsAfterDelete(snapshot, requestedIds, result).map((item) => item.id));
  const currentById = new Map(current.map((item) => [item.id, item]));
  const snapshotIds = new Set(snapshot.map((item) => item.id));
  const ordered: T[] = [];
  for (const item of current) {
    if (!snapshotIds.has(item.id)) ordered.push(item);
  }
  for (const item of snapshot) {
    if (!keptIds.has(item.id)) continue;
    ordered.push(currentById.get(item.id) ?? item);
  }
  return ordered;
}
