import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelDto } from '../src/services/models.js';
import {
  ProviderError,
  builtinProvider,
  providerFor,
  registerProvider,
  resetProviders,
  type ProviderTask,
} from '../src/services/provider.js';
import { createHttpProvider } from '../src/services/http-provider.js';

type Recorded = { method: string; url: string; body: unknown; authorization?: string };

const closers: Array<() => Promise<void>> = [];
const tempFiles: string[] = [];

afterEach(async () => {
  resetProviders();
  while (closers.length) await closers.pop()!();
  for (const path of tempFiles.splice(0)) rmSync(path, { force: true });
});

function model(overrides: Partial<ModelDto> = {}): ModelDto {
  return {
    id: 'model-1',
    name: 'Remote',
    kind: 'video',
    priceLabel: '1',
    priceAmount: 1,
    priceUnit: 'per_call',
    tag: null,
    refs: [],
    durations: [],
    provider: 'http',
    maxDuration: null,
    providerModel: 'vendor-model',
    ...overrides,
  };
}

function task(overrides: Partial<ProviderTask> = {}): ProviderTask {
  return {
    taskId: 'task-1',
    userId: 'user-1',
    type: 'video',
    prompt: 'a cat',
    model: model(),
    width: 1280,
    height: 720,
    duration: 5,
    count: 2,
    seed: 'seed-1',
    refUrls: ['https://cdn.example/ref.png'],
    ...overrides,
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function startMock(handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void | Promise<void>) {
  const requests: Recorded[] = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      body,
      authorization: req.headers.authorization,
    });
    try {
      await handler(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end(err instanceof Error ? err.message : String(err));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('mock server has no port');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections();
    });
  closers.push(close);
  return { baseUrl, requests, close };
}

describe('provider registry', () => {
  it('falls back to the builtin provider when nothing is registered', () => {
    expect(providerFor(model({ provider: 'http' }))).toBe(builtinProvider);
    expect(providerFor(model({ provider: 'missing' })).id).toBe('builtin');
    expect(providerFor(model({ provider: 'missing' })).remote).toBe(false);
  });

  it('resolves a provider by its registered id and still falls back for others', () => {
    const http = createHttpProvider({ id: 'acme', baseUrl: 'http://127.0.0.1:9' });
    registerProvider(http);
    expect(providerFor(model({ provider: 'acme' }))).toBe(http);
    expect(providerFor(model({ provider: 'acme' })).id).toBe('acme');
    expect(providerFor(model({ provider: 'http' }))).toBe(builtinProvider);
  });

  it('resetProviders drops remote adapters without removing builtin', () => {
    registerProvider(createHttpProvider({ id: 'acme', baseUrl: 'http://127.0.0.1:9' }));
    resetProviders();
    expect(providerFor(model({ provider: 'acme' }))).toBe(builtinProvider);
  });
});

describe('HttpProvider', () => {
  it('downloads succeeded outputs and maps kind, size, and cost', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const mp4 = Buffer.from('fake-mp4-bytes');
    const poster = Buffer.from('poster-bytes');
    let polls = 0;
    const mock = await startMock(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/generations') {
        json(res, 202, { jobId: 'job-1' });
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/generations/job-1') {
        polls += 1;
        if (polls === 1) {
          json(res, 200, { status: 'running', progress: 40 });
          return;
        }
        json(res, 200, {
          status: 'succeeded',
          progress: 100,
          costCredits: 12,
          outputs: [
            { url: `${mock.baseUrl}/files/a.png`, mime: 'image/png' },
            { url: `${mock.baseUrl}/files/b.mp4`, mime: 'video/mp4', kind: 'video' },
            { url: `${mock.baseUrl}/files/c.jpg`, mime: 'image/jpeg', kind: 'poster' },
            { url: `${mock.baseUrl}/files/d.bin`, mime: 'application/octet-stream', kind: 'sprite' },
          ],
        });
        return;
      }
      if (req.url === '/files/a.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png);
        return;
      }
      if (req.url === '/files/b.mp4') {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end(mp4);
        return;
      }
      if (req.url === '/files/c.jpg') {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(poster);
        return;
      }
      if (req.url === '/files/d.bin') {
        res.writeHead(200, { 'content-type': 'video/webm' });
        res.end(Buffer.from('clip'));
        return;
      }
      json(res, 404, { message: 'missing' });
    });

    const progress: number[] = [];
    const provider = createHttpProvider({
      id: 'http',
      baseUrl: `${mock.baseUrl}/`,
      apiKey: 'secret',
      pollMs: 20,
      timeoutMs: 5000,
    });
    const result = await provider.run(task(), {
      onProgress: (pct) => {
        progress.push(pct);
      },
    });
    tempFiles.push(...result.outputs.map((file) => file.path));

    expect(provider.remote).toBe(true);
    expect(mock.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/generations',
      authorization: 'Bearer secret',
      body: {
        taskId: 'task-1',
        type: 'video',
        model: 'vendor-model',
        prompt: 'a cat',
        width: 1280,
        height: 720,
        duration: 5,
        count: 2,
        seed: 'seed-1',
        refUrls: ['https://cdn.example/ref.png'],
      },
    });
    expect(result.providerJobId).toBe('job-1');
    expect(result.costActual).toBe(12);
    expect(progress).toContain(40);
    expect(result.outputs.map((file) => file.kind)).toEqual(['image', 'video', 'poster', 'video']);
    expect(result.outputs[0]).toMatchObject({ mime: 'image/png', width: 1280, height: 720, duration: 5, bytes: png.length });
    expect(readFileSync(result.outputs[0].path).equals(png)).toBe(true);
    expect(result.outputs[1]).toMatchObject({ mime: 'video/mp4', duration: 5, bytes: mp4.length });
    expect(result.outputs[2]).toMatchObject({ mime: 'image/jpeg', duration: 0, bytes: poster.length });
    expect(result.outputs[3]).toMatchObject({ kind: 'video', mime: 'video/webm' });
  });

  it('uses model.id when providerModel is blank', async () => {
    const mock = await startMock(async (req, res) => {
      if (req.method === 'POST') {
        json(res, 202, { jobId: 'job-id' });
        return;
      }
      if (req.method === 'GET') {
        json(res, 200, {
          status: 'succeeded',
          progress: 100,
          outputs: [{ url: `${mock.baseUrl}/files/a.png`, mime: 'image/png', kind: 'image' }],
        });
        return;
      }
      res.end(Buffer.from('x'));
    });
    const result = await createHttpProvider({ id: 'http', baseUrl: mock.baseUrl, pollMs: 20, timeoutMs: 3000 }).run(
      task({ model: model({ id: 'catalogue-id', providerModel: '' }), type: 'image', duration: 0 }),
      { onProgress: () => {} },
    );
    tempFiles.push(...result.outputs.map((file) => file.path));
    expect(mock.requests[0]?.body).toMatchObject({ model: 'catalogue-id' });
    expect(mock.requests[0]?.authorization).toBeUndefined();
  });

  it('calls onJobId after 202 and before the first poll', async () => {
    let releaseJob: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseJob = resolve;
    });
    const events: string[] = [];
    const mock = await startMock(async (req, res) => {
      if (req.method === 'POST') {
        json(res, 202, { jobId: 'job-early' });
        return;
      }
      events.push('poll');
      json(res, 200, {
        status: 'succeeded',
        progress: 100,
        outputs: [{ url: `${mock.baseUrl}/files/a.png`, mime: 'image/png', kind: 'image' }],
      });
    });
    const run = createHttpProvider({ id: 'http', baseUrl: mock.baseUrl, pollMs: 20, timeoutMs: 3000 }).run(task(), {
      onProgress: () => {},
      onJobId: async (jobId) => {
        events.push(`job:${jobId}`);
        await gate;
        events.push('job-done');
      },
    });

    await vi.waitFor(() => expect(events).toContain('job:job-early'));
    expect(events).not.toContain('poll');
    releaseJob();
    const result = await run;
    tempFiles.push(...result.outputs.map((file) => file.path));
    expect(events.indexOf('job-done')).toBeLessThan(events.indexOf('poll'));
  });

  it.each([
    [401, 'PROVIDER_AUTH', false, true],
    [403, 'PROVIDER_AUTH', false, true],
    [429, 'PROVIDER_BUSY', true, true],
    [500, 'PROVIDER_ERROR', true, true],
    [408, 'PROVIDER_TIMEOUT', true, true],
    [504, 'PROVIDER_TIMEOUT', true, true],
  ] as const)('maps HTTP %s to %s', async (status, code, retryable, refundable) => {
    const mock = await startMock(async (_req, res) => {
      json(res, status, { message: `upstream ${status}` });
    });
    const run = createHttpProvider({ id: 'http', baseUrl: mock.baseUrl, timeoutMs: 3000 }).run(task(), {
      onProgress: () => {},
    });
    await expect(run).rejects.toBeInstanceOf(ProviderError);
    await expect(run).rejects.toMatchObject({ code, retryable, refundable });
    expect(mock.requests.every((request) => request.method !== 'GET')).toBe(true);
  });

  it('does not retry or refund CONTENT_REJECTED from the response body', async () => {
    const mock = await startMock(async (_req, res) => {
      json(res, 400, { code: 'CONTENT_REJECTED', message: 'blocked' });
    });
    await expect(
      createHttpProvider({ id: 'http', baseUrl: mock.baseUrl, timeoutMs: 3000 }).run(task(), { onProgress: () => {} }),
    ).rejects.toMatchObject({
      code: 'CONTENT_REJECTED',
      message: 'blocked',
      retryable: false,
      refundable: false,
    });
  });

  it('maps a failed poll to a non-retryable PROVIDER_ERROR', async () => {
    const mock = await startMock(async (req, res) => {
      if (req.method === 'POST') {
        json(res, 202, { jobId: 'job-fail' });
        return;
      }
      json(res, 200, { status: 'failed', error: { code: 'UPSTREAM', message: 'render exploded' } });
    });
    await expect(
      createHttpProvider({ id: 'http', baseUrl: mock.baseUrl, pollMs: 20, timeoutMs: 3000 }).run(task(), {
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'render exploded',
      retryable: false,
      refundable: true,
    });
  });

  it('maps a failed poll with CONTENT_REJECTED to a non-refundable error', async () => {
    const mock = await startMock(async (req, res) => {
      if (req.method === 'POST') {
        json(res, 202, { jobId: 'job-reject' });
        return;
      }
      json(res, 200, { status: 'failed', error: { code: 'CONTENT_REJECTED', message: 'nsfw' } });
    });
    await expect(
      createHttpProvider({ id: 'http', baseUrl: mock.baseUrl, pollMs: 20, timeoutMs: 3000 }).run(task(), {
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ code: 'CONTENT_REJECTED', retryable: false, refundable: false });
  });

  it('polls an existing upstream job instead of submitting another one', async () => {
    const png = Buffer.from('png-bytes');
    const mock = await startMock(async (req, res) => {
      if (req.method === 'POST') {
        json(res, 500, { message: 'must not submit again' });
        return;
      }
      if (req.url === '/v1/generations/job-kept') {
        json(res, 200, {
          status: 'succeeded',
          progress: 100,
          costCredits: 4,
          outputs: [{ url: `${mock.baseUrl}/files/a.png`, mime: 'image/png', kind: 'image' }],
        });
        return;
      }
      if (req.url === '/files/a.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png);
        return;
      }
      json(res, 404, { message: 'missing' });
    });
    const seen: string[] = [];
    const result = await createHttpProvider({ id: 'http', baseUrl: mock.baseUrl, pollMs: 20, timeoutMs: 3000 }).run(
      task({ providerJobId: 'job-kept' }),
      {
        onProgress: () => {},
        onJobId: async (jobId) => {
          seen.push(jobId);
        },
      },
    );
    tempFiles.push(...result.outputs.map((file) => file.path));
    expect(mock.requests.some((request) => request.method === 'POST')).toBe(false);
    expect(mock.requests[0]).toMatchObject({ method: 'GET', url: '/v1/generations/job-kept' });
    expect(seen).toEqual([]);
    expect(result.providerJobId).toBe('job-kept');
    expect(result.costActual).toBe(4);
    expect(readFileSync(result.outputs[0].path).equals(png)).toBe(true);
  });

  it('keeps surrounding spaces in a new job id and rejects one raw character over 120', async () => {
    const png = Buffer.from('png-bytes');
    const spaced = ' job-1 ';
    const mock = await startMock(async (req, res) => {
      if (req.method === 'POST') {
        json(res, 202, { jobId: spaced });
        return;
      }
      if (req.url === `/v1/generations/${encodeURIComponent(spaced)}`) {
        json(res, 200, {
          status: 'succeeded',
          progress: 100,
          outputs: [{ url: `${mock.baseUrl}/files/a.png`, mime: 'image/png', kind: 'image' }],
        });
        return;
      }
      if (req.url === '/files/a.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png);
        return;
      }
      json(res, 404, { message: 'missing' });
    });
    const seen: string[] = [];
    const result = await createHttpProvider({ id: 'http', baseUrl: mock.baseUrl, pollMs: 20, timeoutMs: 3000 }).run(
      task(),
      {
        onProgress: () => {},
        onJobId: async (jobId) => {
          seen.push(jobId);
        },
      },
    );
    tempFiles.push(...result.outputs.map((file) => file.path));
    expect(seen).toEqual([spaced]);
    expect(result.providerJobId).toBe(spaced);

    const tooLong = await startMock(async (req, res) => {
      if (req.method === 'POST') json(res, 202, { jobId: `${'a'.repeat(120)} ` });
      else json(res, 500, { message: 'must not poll' });
    });
    const polled: string[] = [];
    await expect(
      createHttpProvider({ id: 'http', baseUrl: tooLong.baseUrl, pollMs: 20, timeoutMs: 3000 }).run(task(), {
        onProgress: () => {},
        onJobId: async (jobId) => {
          polled.push(jobId);
        },
      }),
    ).rejects.toMatchObject({ message: '上游任务编号最长 120 字', refundable: true });
    expect(polled).toEqual([]);
    expect(tooLong.requests.some((request) => request.method === 'GET')).toBe(false);
  });

  it('resumes a stored job id without removing surrounding spaces', async () => {
    const png = Buffer.from('png-bytes');
    const spaced = ' job-kept ';
    const mock = await startMock(async (req, res) => {
      if (req.method === 'POST') {
        json(res, 500, { message: 'must not submit again' });
        return;
      }
      if (req.url === `/v1/generations/${encodeURIComponent(spaced)}`) {
        json(res, 200, {
          status: 'succeeded',
          progress: 100,
          outputs: [{ url: `${mock.baseUrl}/files/a.png`, mime: 'image/png', kind: 'image' }],
        });
        return;
      }
      if (req.url === '/files/a.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png);
        return;
      }
      json(res, 404, { message: 'missing' });
    });
    const result = await createHttpProvider({ id: 'http', baseUrl: mock.baseUrl, pollMs: 20, timeoutMs: 3000 }).run(
      task({ providerJobId: spaced }),
      { onProgress: () => {} },
    );
    tempFiles.push(...result.outputs.map((file) => file.path));
    expect(mock.requests.some((request) => request.method === 'POST')).toBe(false);
    expect(mock.requests[0]).toMatchObject({ method: 'GET', url: `/v1/generations/${encodeURIComponent(spaced)}` });
    expect(result.providerJobId).toBe(spaced);
  });

  it('times out while polling', async () => {
    const mock = await startMock(async (req, res) => {
      if (req.method === 'POST') {
        json(res, 202, { jobId: 'job-slow' });
        return;
      }
      json(res, 200, { status: 'queued', progress: 1 });
    });
    await expect(
      createHttpProvider({ id: 'http', baseUrl: mock.baseUrl, pollMs: 30, timeoutMs: 250 }).run(task(), {
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true, refundable: true });
  });

  it('does not fetch an output URL on another origin', async () => {
    let foreignHits = 0;
    const foreign = await startMock(async (_req, res) => {
      foreignHits += 1;
      res.end('secret');
    });
    const mock = await startMock(async (req, res) => {
      if (req.method === 'POST') {
        json(res, 202, { jobId: 'job-ssrf' });
        return;
      }
      json(res, 200, {
        status: 'succeeded',
        outputs: [{ url: `${foreign.baseUrl}/secret`, mime: 'image/png', kind: 'image' }],
      });
    });

    await expect(
      createHttpProvider({ id: 'http', baseUrl: mock.baseUrl, apiKey: 'secret', pollMs: 20, timeoutMs: 3000 }).run(task(), {
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: '上游产物地址必须与供应商同源', retryable: false });
    expect(foreignHits).toBe(0);
  });

  it('does not follow an output redirect onto another origin', async () => {
    let foreignHits = 0;
    const foreign = await startMock(async (_req, res) => {
      foreignHits += 1;
      res.end('secret');
    });
    const mock = await startMock(async (req, res) => {
      if (req.method === 'POST') {
        json(res, 202, { jobId: 'job-redir' });
        return;
      }
      if (req.url === '/v1/generations/job-redir') {
        json(res, 200, {
          status: 'succeeded',
          outputs: [{ url: '/files/a.png', mime: 'image/png', kind: 'image' }],
        });
        return;
      }
      res.writeHead(302, { location: `${foreign.baseUrl}/secret` });
      res.end();
    });

    await expect(
      createHttpProvider({ id: 'http', baseUrl: mock.baseUrl, pollMs: 20, timeoutMs: 3000 }).run(task(), {
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: '上游产物地址必须与供应商同源', retryable: false });
    expect(foreignHits).toBe(0);
  });

  it('downloads a same-origin relative output URL', async () => {
    const png = Buffer.from('relative-png');
    const mock = await startMock(async (req, res) => {
      if (req.method === 'POST') {
        json(res, 202, { jobId: 'job-rel' });
        return;
      }
      if (req.url === '/v1/generations/job-rel') {
        json(res, 200, { status: 'succeeded', outputs: [{ url: '/files/a.png', mime: 'image/png', kind: 'image' }] });
        return;
      }
      expect(req.headers.authorization).toBe('Bearer secret');
      res.end(png);
    });
    const result = await createHttpProvider({
      id: 'http',
      baseUrl: mock.baseUrl,
      apiKey: 'secret',
      pollMs: 20,
      timeoutMs: 3000,
    }).run(task({ type: 'image' }), { onProgress: () => {} });
    tempFiles.push(...result.outputs.map((file) => file.path));
    expect(readFileSync(result.outputs[0].path).equals(png)).toBe(true);
  });

  it('DELETEs the generation when the signal aborts', async () => {
    const ac = new AbortController();
    const mock = await startMock(async (req, res) => {
      if (req.method === 'POST') {
        json(res, 202, { jobId: 'job-abort' });
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
      await new Promise<void>((resolve) => {
        req.on('close', () => resolve());
      });
      if (!res.writableEnded) res.end();
    });

    const run = createHttpProvider({ id: 'http', baseUrl: mock.baseUrl, pollMs: 20, timeoutMs: 5000 }).run(task(), {
      onProgress: () => {},
      signal: ac.signal,
    });
    await vi.waitFor(() => expect(mock.requests.some((request) => request.method === 'GET')).toBe(true));
    ac.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.requests.some((request) => request.method === 'DELETE' && request.url === '/v1/generations/job-abort')).toBe(
      true,
    );
  });

  it('forwards the task trace id on submit, poll, and download', async () => {
    const seen: string[] = [];
    const png = Buffer.from('traced-png');
    const mock = await startMock(async (req, res) => {
      seen.push(String(req.headers['x-trace-id'] ?? ''));
      if (req.method === 'POST') {
        json(res, 202, { jobId: 'job-trace' });
        return;
      }
      if (req.url === '/v1/generations/job-trace') {
        json(res, 200, { status: 'succeeded', outputs: [{ url: '/files/a.png', mime: 'image/png', kind: 'image' }] });
        return;
      }
      res.end(png);
    });
    const result = await createHttpProvider({ id: 'http', baseUrl: mock.baseUrl, pollMs: 20, timeoutMs: 3000 }).run(
      task({ type: 'image', traceId: 'req-42' }),
      { onProgress: () => {} },
    );
    tempFiles.push(...result.outputs.map((file) => file.path));
    expect(seen).toEqual(['req-42', 'req-42', 'req-42']);
  });

  it('omits the trace header when the id contains a control character', async () => {
    const seen: Array<string | undefined> = [];
    const mock = await startMock(async (req, res) => {
      seen.push(req.headers['x-trace-id'] as string | undefined);
      if (req.method === 'POST') {
        json(res, 202, { jobId: 'job-plain' });
        return;
      }
      json(res, 200, { status: 'succeeded', outputs: [] });
    });
    await createHttpProvider({ id: 'http', baseUrl: mock.baseUrl, pollMs: 20, timeoutMs: 3000 }).run(
      task({ traceId: 'bad\nid' }),
      { onProgress: () => {} },
    );
    expect(seen.every((value) => value === undefined)).toBe(true);
  });
});
