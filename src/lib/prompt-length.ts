const PROMPT_TOO_LONG = '提示词最长 4000 字';
const MAX_PROMPT_LENGTH = 4000;

/** Trimmed prompts longer than 4000 characters cannot be submitted. */
export function promptTooLongMessage(prompt: string): string | null {
  return prompt.trim().length > MAX_PROMPT_LENGTH ? PROMPT_TOO_LONG : null;
}
