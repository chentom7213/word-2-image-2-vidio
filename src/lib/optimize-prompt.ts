/** Append a locale-specific quality suffix once. A leading comma stays off an empty prompt. */
export function optimizedPrompt(current: string, suffix: string): string {
  const body = suffix.replace(/^[，,]\s*/, '');
  if (!current.trim()) return body;
  if (current.includes(body)) return current;
  return current + suffix;
}
