import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelDto } from '../src/services/models.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  exec: vi.fn(),
  withTransaction: vi.fn(),
  getModel: vi.fn(),
  moderateOutputs: vi.fn(),
  providerRun: vi.fn(),
  putObjectFromPath: vi.fn(),
  adjustCredits: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  query: mocks.query,
  queryOne: mocks.queryOne,
  exec: mocks.exec,
  withTransaction: mocks.withTransaction,
  pool: {},
}));
vi.mock('../src/services/models.js', () => ({
  getModel: mocks.getModel,
}));
vi.mock('../src/services/moderation.js', () => ({
  moderateOutputs: mocks.moderateOutputs,
}));
vi.mock('../src/services/audit.js', () => ({ audit: mocks.audit }));
vi.mock('../src/services/credits.js', () => ({ adjustCredits: mocks.adjustCredits }));
vi.mock('../src/services/storage.js', () => ({
  keys: { output: () => 'outputs/user-1/task-1/0-image.png' },
  putObjectFromPath: mocks.putObjectFromPath,
  removeObject: vi.fn(),
  signedUrl: vi.fn(),
}));
vi.mock('../src/services/plans.js', () => ({
  planForUser: async () => ({ features: { watermark: false } }),
}));
vi.mock('../src/services/thumbnail.js', () => ({
  createThumbnailFile: async () => null,
  fitThumbnailEdge: () => null,
  buildThumbnailFfmpegArgs: () => [],
}));

import { executeTask } from '../src/services/pipeline.js';
import {
  ProviderError,
  providerFor,
  registerProvider,
  resetProviders,
  setProviderCircuitClock,
} from '../src/services/provider.js';

const OPEN_MS = 10_000;
const originalEnv = {
  failures: process.env.PROVIDER_CIRCUIT_FAILURES,
  openMs: process.env.PROVIDER_CIRCUIT_OPEN_MS,
};

let now = 0;

function model(provider = 'acme'): ModelDto {
  return {
    id: 'remote-image',
    name: 'Remote',
    kind: 'image',
    priceLabel: '1',
    priceAmount: 1,
    priceUnit: 'per_call',
    tag: null,
    refs: [],
    durations: [],
    provider,
    providerModel: 'vendor-model',
    maxDuration: null,
  };
}

function runningTask() {
  return {
    id: 'task-1',
    user_id: 'user-1',
    org_id: null,
    visibility: 'private' as const,
    type: 'image' as const,
    prompt: 'a red square',
    model_id: 'remote-image',
    model_name: 'Remote',
    width: 64,
    height: 64,
    duration: 0,
    count: 1,
    status: 'running' as const,
    seed: 'seed',
    credits_cost: 1,
  };
}

function execute(isCancelled: () => Promise<boolean> = async () => false) {
  return executeTask('task-1', {
    isCancelled,
    onProgress: async () => {},
    onHeartbeat: async () => {},
  });
}

function fail(code: 'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT' = 'PROVIDER_ERROR') {
  mocks.providerRun.mockRejectedValueOnce(
    new ProviderError(code, code === 'PROVIDER_TIMEOUT' ? '上游生成超时' : '上游 500', {
      retryable: true,
      refundable: true,
    }),
  );
  return execute();
}

function rejectWith(code: 'CONTENT_REJECTED' | 'PROVIDER_AUTH') {
  mocks.providerRun.mockRejectedValueOnce(
    new ProviderError(code, code === 'CONTENT_REJECTED' ? '内容未通过审核' : '上游凭证无效', {
      retryable: false,
      refundable: code !== 'CONTENT_REJECTED',
    }),
  );
  return execute();
}

async function succeed() {
  const dir = mkdtempSync(join(tmpdir(), 'provider-circuit-'));
  const path = join(dir, 'out.png');
  writeFileSync(path, Buffer.from('png'));
  mocks.providerRun.mockResolvedValueOnce({
    providerJobId: 'job-1',
    costActual: 1,
    outputs: [{ path, kind: 'image', mime: 'image/png', width: 64, height: 64, duration: 0, bytes: 3 }],
  });
  try {
    return await execute();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('provider circuit breaker', () => {
  beforeEach(() => {
    now = 1_700_000_000_000;
    setProviderCircuitClock(() => now);
    process.env.PROVIDER_CIRCUIT_FAILURES = '3';
    process.env.PROVIDER_CIRCUIT_OPEN_MS = String(OPEN_MS);
    resetProviders();
    mocks.providerRun.mockReset();
    mocks.providerRun.mockImplementation(() => {
      throw new Error('unexpected provider.run');
    });
    registerProvider({ id: 'acme', remote: true, run: mocks.providerRun });
    mocks.query.mockResolvedValue([]);
    mocks.queryOne.mockResolvedValue(runningTask());
    mocks.exec.mockResolvedValue({ affectedRows: 1 });
    mocks.getModel.mockResolvedValue(model());
    mocks.moderateOutputs.mockResolvedValue({ ok: true });
    mocks.adjustCredits.mockResolvedValue(1);
    mocks.audit.mockResolvedValue(undefined);
    mocks.putObjectFromPath.mockResolvedValue(undefined);
    mocks.withTransaction.mockImplementation(async (fn: (conn: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) =>
      fn({ query: vi.fn().mockResolvedValue([[{ status: 'running', refunded_at: null }]]) }),
    );
  });

  afterEach(() => {
    setProviderCircuitClock(null);
    resetProviders();
    if (originalEnv.failures === undefined) delete process.env.PROVIDER_CIRCUIT_FAILURES;
    else process.env.PROVIDER_CIRCUIT_FAILURES = originalEnv.failures;
    if (originalEnv.openMs === undefined) delete process.env.PROVIDER_CIRCUIT_OPEN_MS;
    else process.env.PROVIDER_CIRCUIT_OPEN_MS = originalEnv.openMs;
  });

  it('still calls the remote provider before the consecutive failure threshold', async () => {
    const first = await fail('PROVIDER_TIMEOUT');
    const second = await fail('PROVIDER_ERROR');

    expect(mocks.providerRun).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ ok: false, code: 'PROVIDER_TIMEOUT', retryable: true });
    expect(second).toMatchObject({ ok: false, code: 'PROVIDER_ERROR', retryable: true });
  });

  it('returns retryable PROVIDER_BUSY and does not call the provider once the threshold is reached', async () => {
    await fail('PROVIDER_TIMEOUT');
    await fail('PROVIDER_ERROR');
    await fail('PROVIDER_ERROR');

    const blocked = await execute();

    expect(mocks.providerRun).toHaveBeenCalledTimes(3);
    expect(blocked).toMatchObject({
      ok: false,
      code: 'PROVIDER_BUSY',
      retryable: true,
      error: '上游连续失败，已暂时熔断',
    });
    expect(providerFor(model()).id).toBe('acme');
    expect(providerFor(model()).remote).toBe(true);
    expect(providerFor(model('missing')).id).toBe('builtin');
  });

  it('calls the provider again after the open window and starts a fresh streak', async () => {
    await fail();
    await fail();
    await fail();
    now += OPEN_MS - 1;

    const stillOpen = await execute();
    expect(stillOpen).toMatchObject({ code: 'PROVIDER_BUSY', retryable: true });
    expect(mocks.providerRun).toHaveBeenCalledTimes(3);

    now += 1;
    const recovered = await fail();
    const second = await fail();

    expect(recovered).toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    expect(second).toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    expect(mocks.providerRun).toHaveBeenCalledTimes(5);
  });

  it('clears the consecutive failure count after one success', async () => {
    await fail();
    await fail();
    const done = await succeed();
    expect(done).toEqual({ ok: true });

    await fail();
    await fail();
    const third = await fail();

    expect(third).toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    expect(mocks.providerRun).toHaveBeenCalledTimes(6);
    const blocked = await execute();
    expect(blocked).toMatchObject({ code: 'PROVIDER_BUSY', retryable: true });
    expect(mocks.providerRun).toHaveBeenCalledTimes(6);
  });

  it('does not count CONTENT_REJECTED toward the breaker', async () => {
    await fail();
    await fail();
    const rejected = await rejectWith('CONTENT_REJECTED');
    await rejectWith('CONTENT_REJECTED');

    expect(rejected).toMatchObject({ code: 'CONTENT_REJECTED', retryable: false });
    expect(mocks.providerRun).toHaveBeenCalledTimes(4);

    await fail();
    expect(mocks.providerRun).toHaveBeenCalledTimes(5);
    const blocked = await execute();
    expect(blocked).toMatchObject({ code: 'PROVIDER_BUSY', retryable: true });
    expect(mocks.providerRun).toHaveBeenCalledTimes(5);
  });

  it('does not count PROVIDER_AUTH or user cancellation', async () => {
    process.env.PROVIDER_CIRCUIT_FAILURES = '2';
    await fail();
    const authed = await rejectWith('PROVIDER_AUTH');
    const cancelled = await execute(async () => true);

    expect(authed).toMatchObject({ code: 'PROVIDER_AUTH' });
    expect(cancelled).toMatchObject({ ok: false, code: 'CANCELLED', retryable: false });
    await fail();
    expect(mocks.providerRun).toHaveBeenCalledTimes(3);

    const blocked = await execute();
    expect(blocked).toMatchObject({ code: 'PROVIDER_BUSY', retryable: true });
    expect(mocks.providerRun).toHaveBeenCalledTimes(3);
  });

  it('does not trip for a non-remote provider and leaves other provider ids alone', async () => {
    process.env.PROVIDER_CIRCUIT_FAILURES = '1';
    resetProviders();
    registerProvider({ id: 'sim', remote: false, run: mocks.providerRun });
    mocks.getModel.mockResolvedValue(model('sim'));

    const first = await fail();
    const second = await fail();

    expect(first).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(second).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(mocks.providerRun).toHaveBeenCalledTimes(2);
    expect(providerFor(model('nobody')).id).toBe('builtin');

    const betaRun = vi.fn().mockRejectedValue(
      new ProviderError('PROVIDER_ERROR', '上游 500', { retryable: true, refundable: true }),
    );
    registerProvider({ id: 'beta', remote: true, run: betaRun });
    mocks.getModel.mockResolvedValue(model('beta'));
    const firstBeta = await execute();
    const secondBeta = await execute();

    expect(firstBeta).toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    expect(secondBeta).toMatchObject({ code: 'PROVIDER_BUSY', retryable: true });
    expect(betaRun).toHaveBeenCalledTimes(1);
    expect(providerFor(model('beta')).id).toBe('beta');
  });

  it('defaults to 5 consecutive failures and a 5 minute window', async () => {
    delete process.env.PROVIDER_CIRCUIT_FAILURES;
    delete process.env.PROVIDER_CIRCUIT_OPEN_MS;

    for (let i = 0; i < 5; i++) await fail();
    expect(mocks.providerRun).toHaveBeenCalledTimes(5);

    const blocked = await execute();
    expect(blocked).toMatchObject({ code: 'PROVIDER_BUSY', retryable: true });
    expect(mocks.providerRun).toHaveBeenCalledTimes(5);

    now += 5 * 60 * 1000 - 1;
    const stillOpen = await execute();
    expect(stillOpen).toMatchObject({ code: 'PROVIDER_BUSY', retryable: true });

    now += 1;
    const recovered = await fail();
    expect(recovered).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(mocks.providerRun).toHaveBeenCalledTimes(6);
  });
});
