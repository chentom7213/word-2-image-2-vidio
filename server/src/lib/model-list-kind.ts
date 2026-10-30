export const MODEL_LIST_KIND_INVALID = '模型种类无效';

export type ModelListKind = 'image' | 'video';

/**
 * 目录只按 image / video 过滤。没传、null、空字符串表示返回全部已启用模型。
 * 其他值（含数组）不能进 SQL，否则未知种类会变成空目录。
 */
export function modelListKind(query: { kind?: unknown }): {
  kind: ModelListKind | null;
  error: string | null;
} {
  const raw = query.kind;
  if (raw === undefined || raw === null || raw === '') return { kind: null, error: null };
  if (raw === 'image' || raw === 'video') return { kind: raw, error: null };
  return { kind: null, error: MODEL_LIST_KIND_INVALID };
}
