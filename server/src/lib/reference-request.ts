const MISSING_REFERENCE = '参考素材不存在或无权使用';

function normalizedIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

/** 客户端要求的参考素材编号必须都能在已授权查询结果里找到。 */
export function missingReferenceMessage(requested: string[], foundIds: string[]): string | null {
  if (requested.length === 0) return null;
  const found = new Set(normalizedIds(foundIds));
  for (const raw of requested) {
    const id = raw.trim();
    if (!id || !found.has(id)) return MISSING_REFERENCE;
  }
  return null;
}
