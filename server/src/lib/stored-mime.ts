/** 去掉参数并转成小写，再按列宽截断。空值返回 null。已经是短的小写类型时保持原样。 */
export function storedMime(mime: string | null | undefined, maxLength: number): string | null {
  const base = String(mime ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!base) return null;
  return base.slice(0, Math.max(0, maxLength));
}
