import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '../env.js';
import type { RenderOutputFile } from '../render/media.js';
import { providerJobIdProblem, recordedJobId } from '../lib/provider-job-id.js';
import { storedTraceId } from '../lib/worker-log.js';
import { ProviderError, registerProvider, type Provider, type ProviderContext, type ProviderTask } from './provider.js';

export type HttpProviderOptions = {
  id: string;
  baseUrl: string;
  apiKey?: string;
  /** Delay between status polls. Default 200ms. */
  pollMs?: number;
  /** Whole submit+poll budget. Default 120000ms. */
  timeoutMs?: number;
};

const DEFAULT_POLL_MS = 200;
const DEFAULT_TIMEOUT_MS = 120_000;
/** Same ceiling as user uploads. A remote render must not fill the worker disk. */
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_REDIRECTS = 3;

/**
 * Registers the generic HTTP adapter when PROVIDER_HTTP_BASE_URL is set.
 * An empty URL leaves the built-in renderer in place.
 */
export function installConfiguredProviders() {
  const configured = env.providers.http;
  if (!configured.baseUrl) return;
  registerProvider(
    createHttpProvider({
      id: configured.id || 'http',
      baseUrl: configured.baseUrl,
      apiKey: configured.apiKey,
      pollMs: configured.pollMs,
      timeoutMs: configured.timeoutMs,
    }),
  );
}

export function createHttpProvider(options: HttpProviderOptions): Provider {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const apiKey = options.apiKey || undefined;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    id: options.id,
    remote: true,
    async run(task, ctx) {
      const deadline = Date.now() + timeoutMs;
      const written: string[] = [];
      let jobUrl: string | undefined;

      try {
        throwIfAborted(ctx.signal);
        const existingJobId = recordedJobId(task.providerJobId);
        let jobId = existingJobId;
        if (!jobId) {
          const submit = await requestJson(`${baseUrl}/v1/generations`, {
            method: 'POST',
            apiKey,
            traceId: task.traceId,
            json: requestBody(task),
            deadline,
            signal: ctx.signal,
          });
          if (submit.status !== 202) throw mapHttpError(submit.status, submit.body);

          jobId = jobIdOf(submit.body);
          const jobIdProblem = providerJobIdProblem(jobId);
          if (jobIdProblem) {
            throw new ProviderError('PROVIDER_ERROR', jobIdProblem, { retryable: false, refundable: true });
          }
          if (!jobId.trim()) throw new ProviderError('PROVIDER_ERROR', '上游未返回任务编号', { retryable: false });
          await ctx.onJobId?.(jobId);
        }
        jobUrl = `${baseUrl}/v1/generations/${encodeURIComponent(jobId)}`;

        while (true) {
          throwIfAborted(ctx.signal);
          assertTime(deadline);
          const poll = await requestJson(jobUrl, {
            method: 'GET',
            apiKey,
            traceId: task.traceId,
            deadline,
            signal: ctx.signal,
          });
          if (poll.status < 200 || poll.status >= 300) throw mapHttpError(poll.status, poll.body);
          throwIfRejected(poll.body);

          const status = typeof poll.body.status === 'string' ? poll.body.status : '';
          await ctx.onProgress(progressOf(poll.body, status));

          if (status === 'succeeded') {
            const outputs = await downloadOutputs(poll.body.outputs, task, ctx, baseUrl, apiKey, deadline, written);
            return { providerJobId: jobId, outputs, costActual: costOf(poll.body.costCredits) };
          }
          if (status === 'failed') throw failedPoll(poll.body);
          if (status !== 'queued' && status !== 'running') {
            throw new ProviderError('PROVIDER_ERROR', `未知上游状态: ${status || 'empty'}`, { retryable: false });
          }

          const wait = Math.min(pollMs, deadline - Date.now());
          if (wait <= 0) throw timeoutError();
          await sleep(wait, ctx.signal);
        }
      } catch (err) {
        await Promise.all(written.map((path) => rm(path, { force: true }).catch(() => {})));
        if (ctx.signal?.aborted || isAbortError(err)) {
          if (jobUrl) await bestEffortDelete(jobUrl, apiKey, task.traceId);
          throw abortError();
        }
        throw err;
      }
    },
  };
}

function requestBody(task: ProviderTask) {
  return {
    taskId: task.taskId,
    type: task.type,
    model: task.model.providerModel?.trim() || task.model.id,
    prompt: task.prompt,
    width: task.width,
    height: task.height,
    duration: task.duration,
    count: task.count,
    seed: task.seed,
    refUrls: task.refUrls,
  };
}

type JsonRequest = {
  method: 'GET' | 'POST' | 'DELETE';
  apiKey?: string;
  traceId?: string | null;
  json?: unknown;
  deadline: number;
  signal?: AbortSignal;
};

function traceHeaders(traceId: string | null | undefined): Record<string, string> {
  const value = storedTraceId(traceId);
  if (!value || /[\s"]/.test(value)) return {};
  return { 'x-trace-id': value };
}

async function requestJson(url: string, req: JsonRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { accept: 'application/json', ...traceHeaders(req.traceId) };
  if (req.json !== undefined) headers['content-type'] = 'application/json';
  if (req.apiKey) headers.authorization = `Bearer ${req.apiKey}`;
  const res = await fetchWithDeadline(
    url,
    {
      method: req.method,
      headers,
      body: req.json !== undefined ? JSON.stringify(req.json) : undefined,
    },
    req.deadline,
    req.signal,
  );
  return { status: res.status, body: asRecord(await readJson(res)) };
}

async function fetchWithDeadline(url: string, init: RequestInit, deadline: number, userSignal?: AbortSignal): Promise<Response> {
  assertTime(deadline);
  throwIfAborted(userSignal);
  const timeoutSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const signal = userSignal ? AbortSignal.any([userSignal, timeoutSignal]) : timeoutSignal;
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (userSignal?.aborted || (isAbortError(err) && !timeoutSignal.aborted)) throw abortError();
    if (timeoutSignal.aborted || (err instanceof Error && err.name === 'TimeoutError')) throw timeoutError();
    const message = err instanceof Error ? err.message : '上游请求失败';
    throw new ProviderError('PROVIDER_ERROR', message, { retryable: true });
  }
}

async function downloadOutputs(
  raw: unknown,
  task: ProviderTask,
  ctx: ProviderContext,
  baseUrl: string,
  apiKey: string | undefined,
  deadline: number,
  written: string[],
): Promise<RenderOutputFile[]> {
  const base = new URL(baseUrl);
  const outputs = Array.isArray(raw) ? raw.map(asRecord) : [];
  const files: RenderOutputFile[] = [];
  for (const output of outputs) {
    throwIfAborted(ctx.signal);
    const rawUrl = typeof output.url === 'string' ? output.url : '';
    if (!rawUrl) throw new ProviderError('PROVIDER_ERROR', '上游产物缺少地址', { retryable: false });
    const res = await fetchSameOrigin(resolveOutputUrl(rawUrl, base), base, apiKey, task.traceId, deadline, ctx.signal);
    if (!res.ok) throw mapHttpError(res.status, asRecord(await readJson(res)));
    const mime = pickMime(output.mime, res.headers.get('content-type'));
    const kind = inferKind(output.kind, mime);
    const path = tempPath(extFor(mime, kind));
    written.push(path);
    await writeBody(res, path);
    files.push({
      kind,
      path,
      mime,
      width: task.width,
      height: task.height,
      duration: kind === 'poster' ? 0 : task.duration,
      bytes: (await stat(path)).size,
    });
  }
  return files;
}

function resolveOutputUrl(raw: string, base: URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw, base);
  } catch {
    throw new ProviderError('PROVIDER_ERROR', '上游产物地址无效', { retryable: false });
  }
  assertSameOrigin(parsed, base);
  return parsed;
}

function assertSameOrigin(url: URL, base: URL) {
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== base.origin || url.username || url.password) {
    throw new ProviderError('PROVIDER_ERROR', '上游产物地址必须与供应商同源', { retryable: false });
  }
}

async function fetchSameOrigin(
  url: URL,
  base: URL,
  apiKey: string | undefined,
  traceId: string | null | undefined,
  deadline: number,
  signal?: AbortSignal,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_OUTPUT_REDIRECTS; hop++) {
    assertSameOrigin(current, base);
    const headers: Record<string, string> = { ...traceHeaders(traceId) };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const res = await fetchWithDeadline(
      current.toString(),
      { method: 'GET', headers, redirect: 'manual' },
      deadline,
      signal,
    );
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    if (!location) throw new ProviderError('PROVIDER_ERROR', '上游产物重定向缺少地址', { retryable: false });
    try {
      current = new URL(location, current);
    } catch {
      throw new ProviderError('PROVIDER_ERROR', '上游产物重定向地址无效', { retryable: false });
    }
  }
  throw new ProviderError('PROVIDER_ERROR', '上游产物重定向次数过多', { retryable: false });
}

async function writeBody(res: Response, path: string) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_OUTPUT_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new ProviderError('PROVIDER_ERROR', '上游产物超过 50MB', { retryable: false });
  }
  mkdirSync(dirname(path), { recursive: true });
  let seen = 0;
  const limited = new Transform({
    transform(chunk, _encoding, callback) {
      seen += chunk.length;
      if (seen > MAX_OUTPUT_BYTES) {
        callback(new ProviderError('PROVIDER_ERROR', '上游产物超过 50MB', { retryable: false }));
        return;
      }
      callback(null, chunk);
    },
  });
  const source = res.body ? Readable.fromWeb(res.body) : Readable.from([]);
  await pipeline(source, limited, createWriteStream(path));
}

function tempPath(ext: string) {
  const dir = join(tmpdir(), 'benchu-render');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomUUID()}.${ext}`);
}

async function bestEffortDelete(url: string, apiKey?: string, traceId?: string | null) {
  try {
    const headers: Record<string, string> = { ...traceHeaders(traceId) };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(5_000) });
  } catch {
    // Cancellation still wins when the upstream cancel call cannot land.
  }
}

function mapHttpError(status: number, body: Record<string, unknown>): ProviderError {
  const code = errorCode(body);
  const message = errorMessage(body) ?? `上游返回 ${status}`;
  if (code === 'CONTENT_REJECTED') {
    return new ProviderError('CONTENT_REJECTED', message, { retryable: false, refundable: false });
  }
  if (status === 401 || status === 403) {
    return new ProviderError('PROVIDER_AUTH', message, { retryable: false, refundable: true });
  }
  if (status === 429) {
    return new ProviderError('PROVIDER_BUSY', message, { retryable: true, refundable: true });
  }
  if (status === 408 || status === 504) {
    return new ProviderError('PROVIDER_TIMEOUT', message, { retryable: true, refundable: true });
  }
  if (status >= 500) {
    return new ProviderError('PROVIDER_ERROR', message, { retryable: true, refundable: true });
  }
  return new ProviderError('PROVIDER_ERROR', message, { retryable: false, refundable: true });
}

function failedPoll(body: Record<string, unknown>): ProviderError {
  const code = errorCode(body);
  const message = errorMessage(body) ?? '上游生成失败';
  if (code === 'CONTENT_REJECTED') {
    return new ProviderError('CONTENT_REJECTED', message, { retryable: false, refundable: false });
  }
  return new ProviderError('PROVIDER_ERROR', message, { retryable: false, refundable: true });
}

function throwIfRejected(body: Record<string, unknown>) {
  if (errorCode(body) === 'CONTENT_REJECTED' && body.status !== 'failed') {
    throw new ProviderError('CONTENT_REJECTED', errorMessage(body) ?? '内容被拒绝', {
      retryable: false,
      refundable: false,
    });
  }
}

function errorCode(body: Record<string, unknown>): string | undefined {
  const nested = asRecord(body.error);
  return asString(body.code) ?? asString(nested.code);
}

function errorMessage(body: Record<string, unknown>): string | undefined {
  const nested = asRecord(body.error);
  return asString(nested.message) ?? asString(body.message);
}

function jobIdOf(body: Record<string, unknown>): string {
  const raw = body.jobId;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return '';
}

function progressOf(body: Record<string, unknown>, status: string): number {
  const reported = Number(body.progress);
  if (Number.isFinite(reported)) return reported;
  if (status === 'succeeded') return 100;
  if (status === 'running') return 50;
  return 10;
}

function costOf(value: unknown): number {
  const cost = Number(value);
  return Number.isFinite(cost) ? cost : 0;
}

function inferKind(kind: unknown, mime: string): RenderOutputFile['kind'] {
  if (kind === 'image' || kind === 'video' || kind === 'poster') return kind;
  if (mime.startsWith('video/')) return 'video';
  return 'image';
}

function pickMime(declared: unknown, header: string | null): string {
  const fromBody = usefulMime(declared);
  if (fromBody) return fromBody;
  return usefulMime(header) ?? 'application/octet-stream';
}

function usefulMime(value: unknown): string | undefined {
  const mime = asString(value)?.split(';')[0]?.trim().toLowerCase();
  if (!mime || mime === 'application/octet-stream') return undefined;
  return mime;
}

function extFor(mime: string, kind: RenderOutputFile['kind']): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('quicktime')) return 'mov';
  if (kind === 'video') return 'mp4';
  return 'img';
}

function timeoutError(): ProviderError {
  return new ProviderError('PROVIDER_TIMEOUT', '上游生成超时', { retryable: true, refundable: true });
}

function abortError(): DOMException {
  return new DOMException('生成已取消', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function assertTime(deadline: number) {
  if (Date.now() >= deadline) throw timeoutError();
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function sleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
