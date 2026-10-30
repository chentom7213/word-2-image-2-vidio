export type ProcessLogValue = string | number | boolean | null;

const SECRET_KEYS = new Set(['email', 'prompt', 'password', 'authorization', 'token']);

/** Same switch as the API logger: production, or an explicit JSON flag. */
export function jsonLogsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || env.LOG_JSON === 'true';
}

/** Collapses a thrown value onto one log line and drops control characters. */
export function oneLineDetail(value: unknown, max = 300): string {
  const text = value instanceof Error ? value.message : String(value ?? '');
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function formatProcessLog(
  fields: Record<string, ProcessLogValue>,
  json: boolean,
  text: string,
): string {
  if (!json) return text;
  const body: Record<string, ProcessLogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEYS.has(key)) continue;
    body[key] = typeof value === 'string' ? oneLineDetail(value) : value;
  }
  return JSON.stringify(body);
}

/** Development keeps the readable line. Production writes one JSON object. */
export function emitProcessLog(
  level: 'info' | 'warn' | 'error',
  text: string,
  fields: Record<string, ProcessLogValue>,
): void {
  const line = formatProcessLog(fields, jsonLogsEnabled(), text);
  if (level === 'warn') console.warn(line);
  else if (level === 'error') console.error(line);
  else console.log(line);
}
