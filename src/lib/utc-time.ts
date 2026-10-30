/** MySQL datetimes are UTC. A missing zone stays UTC; an existing zone is kept. */
export function parseUtcMillis(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const withZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}

/** Read as UTC, then show the runtime local clock. */
export function formatUtcLocal(value: string): string {
  const parsed = parseUtcMillis(value);
  if (parsed == null) return value;
  const d = new Date(parsed);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Show the UTC clock, not the browser's local hours. */
export function formatUtcClock(value: string): string {
  const parsed = parseUtcMillis(value);
  if (parsed == null) return value;
  const d = new Date(parsed);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
