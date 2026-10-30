/** Same cap as the runner: 1s, 2s, 4s, … up to 30s. */
export function retryDelayMs(attempts: number): number {
  const n = Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0;
  return Math.min(30_000, 1_000 * 2 ** Math.min(n, 16));
}

export function formatUtcMysql(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
}

export function nextAttemptAt(attempts: number, now = Date.now()): string {
  return formatUtcMysql(new Date(now + retryDelayMs(attempts)));
}

/** Queued rows still inside their backoff stay out of the worker. */
export function queuedReadySql(column = 'next_attempt_at'): string {
  return `(${column} IS NULL OR ${column} <= UTC_TIMESTAMP(3))`;
}

export function missingNextAttemptColumn(err: unknown): boolean {
  const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : '';
  const message = err instanceof Error ? err.message : String(err ?? '');
  return code === 'ER_BAD_FIELD_ERROR' || message.includes('next_attempt_at');
}

export async function withNextAttemptColumn<T>(run: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!missingNextAttemptColumn(err)) throw err;
    return fallback();
  }
}
