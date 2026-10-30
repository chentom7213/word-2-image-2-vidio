/** null 和 undefined 返回 null。其余先转成字符串，按原文字符截到 45，不去掉首尾空白。 */
export function sessionIp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, 45);
}
