import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  exec: vi.fn(),
  withTransaction: vi.fn(),
  providerRun: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  query: mocks.query,
  queryOne: mocks.queryOne,
  exec: mocks.exec,
  withTransaction: mocks.withTransaction,
  pool: {},
}));
vi.mock('../src/services/models.js', () => ({
  getModel: vi.fn().mockResolvedValue({
    id: 'builtin-video',
    provider: 'builtin',
    displayName: 'Builtin video',
    kind: 'video',
  }),
}));
vi.mock('../src/services/provider.js', () => ({
  ProviderError: class ProviderError extends Error {
    code = 'PROVIDER_ERROR';
    retryable = false;
    refundable = true;
  },
  providerFor: () => ({ id: 'builtin', remote: false, run: mocks.providerRun }),
  isSimulated: () => true,
  isProviderCircuitOpen: () => false,
  recordProviderSuccess: () => {},
  recordProviderFailure: () => {},
}));
vi.mock('../src/services/moderation.js', () => ({
  moderateOutputs: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../src/services/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../src/services/credits.js', () => ({ adjustCredits: vi.fn() }));
vi.mock('../src/services/storage.js', () => ({
  keys: { output: vi.fn() },
  putObjectFromPath: vi.fn(),
  removeObject: vi.fn(),
  signedUrl: vi.fn(),
}));

import { executeTask } from '../src/services/pipeline.js';

describe('running task cancellation', () => {
  it('aborts the active provider and returns the existing CANCELLED terminal state', async () => {
    vi.useFakeTimers();
    try {
      mocks.queryOne.mockResolvedValue({
        id: 'task-1',
        user_id: 'user-1',
        org_id: null,
        visibility: 'private',
        type: 'video',
        prompt: 'cancel me',
        model_id: 'builtin-video',
        model_name: 'Builtin video',
        width: 640,
        height: 360,
        duration: 10,
        count: 1,
        status: 'running',
        seed: 'seed',
      });
      mocks.query.mockResolvedValue([]);
      let observedSignal: AbortSignal | undefined;
      mocks.providerRun.mockImplementation((_task, ctx: { signal?: AbortSignal }) => {
        observedSignal = ctx.signal;
        return new Promise((_resolve, reject) => {
          ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason), { once: true });
        });
      });
      const isCancelled = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);

      const execution = executeTask('task-1', {
        isCancelled,
        onProgress: vi.fn(),
        onHeartbeat: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(300);
      const result = await execution;

      expect(observedSignal?.aborted).toBe(true);
      expect(result).toEqual({ ok: false, error: '任务已取消', code: 'CANCELLED', retryable: false });
      expect(mocks.providerRun).toHaveBeenCalledTimes(1);
      expect(mocks.exec).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
