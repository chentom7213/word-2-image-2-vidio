import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(), query: vi.fn(), queryOne: vi.fn(), ack: vi.fn(), claimStale: vi.fn(),
  enqueue: vi.fn(), queueDepth: vi.fn(), readGroup: vi.fn(), redisAvailable: vi.fn(), trimStream: vi.fn(),
  claimTask: vi.fn(), executeTask: vi.fn(), failTask: vi.fn(), loadTask: vi.fn(), refundTask: vi.fn(),
  reapStaleTasks: vi.fn(), incCounter: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({ exec: mocks.exec, query: mocks.query, queryOne: mocks.queryOne }));
vi.mock('../src/services/queue.js', () => ({
  ack: mocks.ack, claimStale: mocks.claimStale, enqueue: mocks.enqueue, queueDepth: mocks.queueDepth,
  readGroup: mocks.readGroup, redisAvailable: mocks.redisAvailable, trimStream: mocks.trimStream,
}));
vi.mock('../src/services/pipeline.js', () => ({
  claimTask: mocks.claimTask, executeTask: mocks.executeTask, failTask: mocks.failTask,
  loadTask: mocks.loadTask, refundTask: mocks.refundTask, reapStaleTasks: mocks.reapStaleTasks,
}));
vi.mock('../src/lib/metrics.js', () => ({ incCounter: mocks.incCounter, observeHistogram: vi.fn() }));

import { processMessage, QueueRunner } from '../src/services/runner.js';

const task = { id: 'task-1', status: 'queued', type: 'video', model_id: 'model-1', attempts: 0, max_attempts: 3, priority: 5 };

describe('worker retry state transitions', () => {
  beforeEach(() => {
    mocks.loadTask.mockResolvedValue({ ...task });
    mocks.claimTask.mockResolvedValue(true);
    mocks.executeTask.mockResolvedValue({ ok: false, retryable: true, error: 'busy', code: 'PROVIDER_BUSY' });
    mocks.exec.mockResolvedValue({ affectedRows: 1 });
    mocks.enqueue.mockResolvedValue(undefined);
    mocks.ack.mockResolvedValue(undefined);
    mocks.claimStale.mockResolvedValue([]);
    mocks.readGroup.mockResolvedValue([]);
    mocks.redisAvailable.mockReturnValue(false);
    mocks.trimStream.mockResolvedValue(undefined);
    mocks.queryOne.mockResolvedValue(null);
  });

  it('waits for reclaimed background work before the runner stops', async () => {
    let finishExecution!: (value: { ok: true }) => void;
    const execution = new Promise<{ ok: true }>((resolve) => {
      finishExecution = resolve;
    });
    let releaseRead!: (value: []) => void;
    const blockedRead = new Promise<[]>((resolve) => {
      releaseRead = resolve;
    });
    mocks.redisAvailable.mockReturnValue(true);
    mocks.claimStale.mockResolvedValue([{ taskId: task.id, entryId: '1-0', priority: 5 }]);
    mocks.readGroup.mockReturnValue(blockedRead);
    mocks.executeTask.mockReturnValue(execution);

    const runner = new QueueRunner(1);
    await runner.start();
    await vi.waitFor(() => expect(mocks.executeTask).toHaveBeenCalledWith(task.id));

    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    releaseRead([]);
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishExecution({ ok: true });
    await stopping;
    expect(mocks.ack).toHaveBeenCalledWith('1-0');
    expect(stopped).toBe(true);
  });

  it('repairs an interrupted failed-task refund before acknowledging redelivery', async () => {
    mocks.loadTask.mockResolvedValue({
      ...task,
      status: 'failed',
      credits_cost: 30,
      refunded_at: null,
      error_code: 'RENDER_ERROR',
    });

    await processMessage(task.id, { ackEntryId: 'refund-recovery-1' });

    expect(mocks.claimTask).not.toHaveBeenCalled();
    expect(mocks.refundTask).toHaveBeenCalledWith(task.id, 'RENDER_ERROR');
    expect(mocks.refundTask.mock.invocationCallOrder[0]).toBeLessThan(mocks.ack.mock.invocationCallOrder[0]);
  });

  afterEach(() => vi.useRealTimers());

  it('keeps the task running until failTask writes the terminal error on the final attempt', async () => {
    mocks.incCounter.mockClear();
    mocks.loadTask.mockResolvedValue({ ...task, attempts: 2, max_attempts: 3 });
    await processMessage(task.id, { ackEntryId: 'final-1' });

    expect(mocks.exec).toHaveBeenCalledWith(
      expect.stringContaining("SET attempts = ? WHERE id = ? AND status = 'running'"), [3, task.id],
    );
    expect(mocks.exec.mock.calls.some(([sql]) => String(sql).includes("status = 'failed'"))).toBe(false);
    expect(mocks.failTask).toHaveBeenCalledWith(task.id, 'busy', 'PROVIDER_BUSY');
    expect(mocks.refundTask).toHaveBeenCalledWith(task.id, 'PROVIDER_BUSY');
    expect(mocks.failTask.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.ack.mock.invocationCallOrder.at(-1)!);
    expect(mocks.refundTask.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.ack.mock.invocationCallOrder.at(-1)!);
    expect(mocks.incCounter).toHaveBeenCalledWith('benchu_tasks_dead_letter_total', expect.any(String), 1, {
      model: task.model_id,
    });
  });

  it('returns the task to queued and republishes it before attempts are exhausted', async () => {
    vi.useFakeTimers();
    mocks.incCounter.mockClear();
    await processMessage(task.id, { ackEntryId: 'retry-1' });
    expect(mocks.exec).toHaveBeenCalledWith(expect.stringContaining('next_attempt_at'), [1, expect.any(String), task.id]);
    expect(mocks.failTask).not.toHaveBeenCalled();
    expect(mocks.exec.mock.invocationCallOrder[0]).toBeLessThan(mocks.ack.mock.invocationCallOrder[0]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.enqueue).toHaveBeenCalledWith(task.id, task.priority);
    expect(mocks.incCounter.mock.calls.some((call) => call[0] === 'benchu_tasks_dead_letter_total')).toBe(false);
  });

  it('writes taskId, userId and traceId on the worker line and leaves the prompt out', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.loadTask.mockResolvedValue({
      ...task,
      user_id: 'user-1',
      trace_id: 'trace-1',
      prompt: 'secret prompt',
      email: 'alice@example.com',
    });
    mocks.executeTask.mockResolvedValue({ ok: true });

    await processMessage(task.id, { ackEntryId: 'log-1' });

    const line = spy.mock.calls.map((call) => String(call[0])).find((text) => text.includes('worker task'));
    expect(line).toContain('"taskId":"task-1"');
    expect(line).toContain('"userId":"user-1"');
    expect(line).toContain('"traceId":"trace-1"');
    expect(line).not.toContain('secret prompt');
    expect(line).not.toContain('alice@example.com');
    spy.mockRestore();
  });

  it('counts an upstream credential rejection on its own series', async () => {
    mocks.incCounter.mockClear();
    mocks.executeTask.mockResolvedValue({ ok: false, retryable: false, code: 'PROVIDER_AUTH' });
    await processMessage(task.id);
    expect(mocks.incCounter).toHaveBeenCalledWith('benchu_provider_auth_total', expect.any(String), 1, {
      model: task.model_id,
    });
  });

  it('leaves the credential counter untouched for other failures', async () => {
    mocks.incCounter.mockClear();
    await processMessage(task.id);
    expect(mocks.incCounter.mock.calls.some((call) => call[0] === 'benchu_provider_auth_total')).toBe(false);
  });
});
