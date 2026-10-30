/** 创建任务请求体 Zod 路径第一段。type / duration / count / visibility 换成中文，其余交给原 message。 */
export function generationFieldMessage(issuePath: PropertyKey | undefined): string | null {
  if (issuePath === 'type') return '任务种类无效';
  if (issuePath === 'duration') return '时长需为 0 到 120 的整数';
  if (issuePath === 'count') return '生成数量需在 1~8 之间';
  if (issuePath === 'visibility') return '可见性无效';
  return null;
}
