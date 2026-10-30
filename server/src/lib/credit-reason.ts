export const CREDIT_REASON_MAX_LENGTH = 120;

/** 流水原因列只有 120 字。短名称保持原句；超长时保留前缀，只截短后面的名称。 */
export function creditReason(label: string, detail: string): string {
  const full = `${label}${detail}`;
  if (full.length <= CREDIT_REASON_MAX_LENGTH) return full;
  const room = CREDIT_REASON_MAX_LENGTH - label.length;
  if (room <= 0) return label.slice(0, CREDIT_REASON_MAX_LENGTH);
  return `${label}${detail.slice(0, room)}`;
}
