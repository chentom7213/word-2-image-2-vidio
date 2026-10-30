export const ASSET_LIST_KIND_INVALID = '素材种类无效';

export type AssetListKind = 'image' | 'video' | 'audio';

/** 没传、null、空字符串不按种类过滤。image、video、audio 原样返回。其他值（含数组）无效。 */
export function parseAssetListKind(query: unknown): {
  kind: AssetListKind | null;
  error: string | null;
} {
  const kind = readKind(query);
  if (kind === undefined || kind === null || kind === '') return { kind: null, error: null };
  if (kind === 'image' || kind === 'video' || kind === 'audio') return { kind, error: null };
  return { kind: null, error: ASSET_LIST_KIND_INVALID };
}

function readKind(query: unknown): unknown {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return undefined;
  return (query as { kind?: unknown }).kind;
}
