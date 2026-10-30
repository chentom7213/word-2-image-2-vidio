export const GENERATION_LIST_TYPE_INVALID = '任务种类无效';

export type GenerationListType = 'image' | 'video';

/**
 * 列表只按 image / video 过滤。没传、null、空字符串表示不按种类过滤。
 * 其他值（含数组）不能进 SQL，否则未知种类会变成空列表。
 */
export function generationListType(query: { type?: unknown }): {
  type: GenerationListType | null;
  error: string | null;
} {
  const raw = query.type;
  if (raw === undefined || raw === null || raw === '') return { type: null, error: null };
  if (raw === 'image' || raw === 'video') return { type: raw, error: null };
  return { type: null, error: GENERATION_LIST_TYPE_INVALID };
}
