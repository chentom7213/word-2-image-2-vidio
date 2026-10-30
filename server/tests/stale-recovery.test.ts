import { describe, expect, it } from 'vitest';
import { staleRecovery } from '../src/services/stale-recovery.js';

describe('stale task recovery', () => {
  it('resumes a task that already has an upstream job and attempts left', () => {
    expect(staleRecovery({ provider_job_id: 'job-1', attempts: 1, max_attempts: 3 })).toBe('resume');
  });

  it('refunds when there is no upstream job id', () => {
    expect(staleRecovery({ provider_job_id: null, attempts: 0, max_attempts: 3 })).toBe('refund');
    expect(staleRecovery({ provider_job_id: '   ', attempts: 0, max_attempts: 3 })).toBe('refund');
  });

  it('refunds when the next attempt would exhaust the budget', () => {
    expect(staleRecovery({ provider_job_id: 'job-1', attempts: 2, max_attempts: 3 })).toBe('refund');
  });
});
