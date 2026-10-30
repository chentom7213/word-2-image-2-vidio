/** null 和 undefined 保持 null。其余先转成字符串，按原文字符截到 maxLength，不去掉首尾空白。 */
export function auditField(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}
