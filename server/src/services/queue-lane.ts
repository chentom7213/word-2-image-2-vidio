/**
 * Paid work should not wait behind a free-plan backlog.
 *
 * Priority 1 is the front of the line. Existing rows were inserted as 5 and
 * stay on the original stream so an upgrade does not require moving messages.
 */
export type QueueLane = 'high' | 'default' | 'low';

export function taskPriorityForPlan(planId: string): number {
  if (planId === 'enterprise') return 1;
  if (planId === 'pro') return 3;
  return 7;
}

export function laneForPriority(priority: number): QueueLane {
  if (!Number.isFinite(priority)) return 'default';
  if (priority <= 2) return 'high';
  if (priority >= 6) return 'low';
  return 'default';
}

/** The default lane keeps the configured stream name. The other two are suffixes. */
export function streamForLane(base: string, lane: QueueLane): string {
  if (lane === 'default') return base;
  return `${base}:${lane}`;
}

export function laneStreamKeys(base: string): string[] {
  return (['high', 'default', 'low'] as const).map((lane) => streamForLane(base, lane));
}

/**
 * Priority to pass to enqueue from a stored row.
 * A finite number is used unchanged, including a stored 5.
 * Anything that cannot be read as a finite number stays at 5, the historical default.
 */
/** A missing priority sorts with the historical default, not ahead of priority 1. */
export const storedQueuePrioritySql = 'COALESCE(priority, 5)';

export function storedQueuePriority(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 5;
  if (typeof value !== 'string') return 5;
  const text = value.trim();
  if (text === '') return 5;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 5;
}
