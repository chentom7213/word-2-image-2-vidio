export const PROMPT_MAX_LENGTH = 4000;

export const PROMPT_TOO_LONG = '提示词最长 4000 字';

/** trim 之后超过上限才拒绝；空白和刚好到上限都放行。 */
export function promptTooLongMessage(prompt: string): string | null {
  if (prompt.trim().length > PROMPT_MAX_LENGTH) return PROMPT_TOO_LONG;
  return null;
}
