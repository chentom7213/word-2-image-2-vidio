export type StaleTask = {
  provider_job_id?: string | null;
  attempts?: number | null;
  max_attempts?: number | null;
};

/**
 * A running task that already has an upstream job id can be polled again.
 * Without that id, or once the next attempt would exhaust the budget, the
 * reaper fails the task and refunds.
 */
export function staleRecovery(row: StaleTask): 'resume' | 'refund' {
  const jobId = String(row.provider_job_id ?? '').trim();
  if (!jobId) return 'refund';
  const attempts = Number(row.attempts ?? 0);
  const maxAttempts = Number(row.max_attempts ?? 0);
  if (!Number.isFinite(attempts) || !Number.isFinite(maxAttempts) || attempts + 1 >= maxAttempts) return 'refund';
  return 'resume';
}
