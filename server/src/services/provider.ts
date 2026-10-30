import { randomUUID } from 'node:crypto';
import { renderImage, renderPoster, renderVideo, type RenderOutputFile } from '../render/media.js';
import { env } from '../env.js';
import type { ModelDto } from './models.js';

export type ProviderTask = {
  taskId: string;
  userId: string;
  type: 'image' | 'video';
  prompt: string;
  model: ModelDto;
  width: number;
  height: number;
  duration: number;
  count: number;
  seed: string;
  /** Signed URLs of reference assets, resolved by the worker. */
  refUrls: string[];
  /**
   * Upstream job already accepted. A retry or reaper resume must poll this
   * id instead of submitting a second job.
   */
  providerJobId?: string | null;
  /** Request id stored on the task. Remote calls forward it as `x-trace-id`. */
  traceId?: string | null;
};

export type ProviderResult = {
  providerJobId: string;
  outputs: RenderOutputFile[];
  /** Actual upstream cost in credits, used for reconciliation. */
  costActual: number;
};

export type ProviderContext = {
  onProgress: (pct: number) => Promise<void> | void;
  signal?: AbortSignal;
  /** Persist the upstream job id as soon as submit acknowledges it. */
  onJobId?: (jobId: string) => Promise<void> | void;
};

export type Provider = {
  /** Provider family, matched against `model_registry.provider`. */
  readonly id: string;
  /**
   * True when this provider calls a real upstream API. The built-in engine
   * reports false so the task record can flag simulated renders.
   */
  readonly remote: boolean;
  run(task: ProviderTask, ctx: ProviderContext): Promise<ProviderResult>;
};

type ProviderErrorCode = 'PROVIDER_AUTH' | 'PROVIDER_BUSY' | 'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT' | 'CONTENT_REJECTED';

export class ProviderError extends Error {
  code: ProviderErrorCode;
  retryable: boolean;
  /** Providers that already burned upstream cost should not be refunded. */
  refundable: boolean;
  constructor(code: ProviderErrorCode, message: string, opts: { retryable?: boolean; refundable?: boolean } = {}) {
    super(message);
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.refundable = opts.refundable ?? true;
  }
}

/**
 * Built-in rendering engine.
 *
 * Every model in `model_registry` routes here unless a matching remote adapter
 * is registered below. Semantics intentionally mirror a real video API:
 * submit returns a job id, progress is reported incrementally, and outputs are
 * real files (PNG / H.264 MP4) rather than placeholders.
 */
export const builtinProvider: Provider = {
  id: 'builtin',
  remote: false,
  async run(task, ctx) {
    const jobId = `builtin-${randomUUID()}`;
    const base = {
      prompt: task.prompt,
      width: task.width,
      height: task.height,
      duration: task.duration,
      count: task.count,
      seed: task.seed,
      fps: env.render.fps,
      onProgress: ctx.onProgress,
      signal: ctx.signal,
    };

    if (task.type === 'image') {
      await ctx.onProgress(5);
      const images = await renderImage({
        ...base,
        count: task.count,
        onProgress: (pct) => ctx.onProgress(5 + pct * 0.9),
      });
      return { providerJobId: jobId, outputs: images, costActual: 0 };
    }

    const [video, poster] = [
      await renderVideo({ ...base, onProgress: (pct) => ctx.onProgress(5 + pct * 0.88) }),
      await renderPoster(base),
    ];
    await ctx.onProgress(97);
    return { providerJobId: jobId, outputs: [video, poster], costActual: 0 };
  },
};

/**
 * Remote adapters land here. Each entry must translate our normalized request
 * into the vendor's payload and map their error codes onto ProviderError.
 *
 * Until credentials are configured the built-in engine serves the request, so a
 * model never becomes unusable just because an upstream key is missing.
 */
const remoteAdapters = new Map<string, Provider>();

/**
 * Consecutive remote failures that open the breaker, and how long it stays
 * open. Read on each check so callers can override them through the
 * environment without sharing a write to `env.ts`.
 *
 *   PROVIDER_CIRCUIT_FAILURES  default 5
 *   PROVIDER_CIRCUIT_OPEN_MS   default 5 minutes
 */
const DEFAULT_CIRCUIT_FAILURES = 5;
const DEFAULT_CIRCUIT_OPEN_MS = 5 * 60 * 1000;
const CIRCUIT_FAILURE_CODES = new Set(['PROVIDER_ERROR', 'PROVIDER_TIMEOUT']);

type CircuitState = {
  failures: number;
  /** Epoch ms when calls may resume. 0 means the breaker is closed. */
  openUntil: number;
};

const providerCircuits = new Map<string, CircuitState>();
let providerCircuitNow: () => number = () => Date.now();

function readCircuitNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return value;
}

function circuitFailureLimit(): number {
  return Math.floor(readCircuitNumber(process.env.PROVIDER_CIRCUIT_FAILURES, DEFAULT_CIRCUIT_FAILURES));
}

function circuitOpenMs(): number {
  return readCircuitNumber(process.env.PROVIDER_CIRCUIT_OPEN_MS, DEFAULT_CIRCUIT_OPEN_MS);
}

/** Drop a streak whose open window has already elapsed so the next failure starts clean. */
function circuitState(providerId: string, now: number): CircuitState {
  const current = providerCircuits.get(providerId);
  if (!current) return { failures: 0, openUntil: 0 };
  if (current.openUntil > 0 && now >= current.openUntil) {
    providerCircuits.delete(providerId);
    return { failures: 0, openUntil: 0 };
  }
  return current;
}

/** Test-only clock. Pass null to restore `Date.now`. */
export function setProviderCircuitClock(now: (() => number) | null): void {
  providerCircuitNow = now ?? (() => Date.now());
}

export function isProviderCircuitOpen(providerId: string): boolean {
  const now = providerCircuitNow();
  return circuitState(providerId, now).openUntil > now;
}

/** A completed remote run clears that provider's failure streak and closes the breaker. */
export function recordProviderSuccess(providerId: string): void {
  providerCircuits.delete(providerId);
}

/**
 * Count a remote failure toward the breaker.
 * Only `PROVIDER_ERROR` and `PROVIDER_TIMEOUT` count. Auth failures, content
 * rejection, rate limits, and cancellation are ignored and do not reset the streak.
 */
export function recordProviderFailure(providerId: string, code: string): void {
  if (!CIRCUIT_FAILURE_CODES.has(code)) return;
  const now = providerCircuitNow();
  const failures = circuitState(providerId, now).failures + 1;
  providerCircuits.set(providerId, {
    failures,
    openUntil: failures >= circuitFailureLimit() ? now + circuitOpenMs() : 0,
  });
}

export function registerProvider(provider: Provider) {
  remoteAdapters.set(provider.id, provider);
}

/** Test-only. Drops remote adapters and breaker state; `builtinProvider` stays the fallback. */
export function resetProviders() {
  remoteAdapters.clear();
  providerCircuits.clear();
}

export function providerFor(model: ModelDto): Provider {
  return remoteAdapters.get(model.provider) ?? builtinProvider;
}

export function isSimulated(model: ModelDto): boolean {
  const p = providerFor(model);
  return !p.remote;
}
