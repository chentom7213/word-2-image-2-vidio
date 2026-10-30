/** Keep a request id that can be stored and printed on one log line. */
export function storedTraceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sliced = value.trim().slice(0, 64);
  if (!sliced || /[\u0000-\u001f\u007f]/.test(sliced)) return null;
  return sliced;
}

/**
 * Fields for one worker line. Email and prompt are never copied, even when
 * the task row still has them.
 */
export function workerTaskFields(task: {
  id: string;
  user_id?: string | null;
  trace_id?: string | null;
  prompt?: string | null;
  email?: string | null;
}): { taskId: string; userId?: string; traceId?: string } {
  const fields: { taskId: string; userId?: string; traceId?: string } = { taskId: task.id };
  const userId = task.user_id?.trim();
  if (userId) fields.userId = userId;
  const traceId = storedTraceId(task.trace_id);
  if (traceId) fields.traceId = traceId;
  return fields;
}
