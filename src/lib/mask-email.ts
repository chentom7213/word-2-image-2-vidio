/** Shows the first and last character of the local part. The domain stays visible. */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return '***';
  const local = Array.from(trimmed.slice(0, at));
  const domain = trimmed.slice(at + 1);
  if (local.length === 0 || domain.length === 0) return '***';
  const masked = local.length <= 2 ? `${local[0]}***` : `${local[0]}***${local[local.length - 1]}`;
  return `${masked}@${domain}`;
}
