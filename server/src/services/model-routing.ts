/**
 * Pure model routing.
 *
 * Automatic selection ranks enabled models of one kind by sort weight, then
 * price. Health of 0 cannot win, and a remote provider with an open circuit
 * cannot win. A non-remote model may still win that ranking.
 *
 * Circuit failover is a different decision. It runs only when the current
 * provider is remote and its circuit is already open, and the standby must
 * itself be remote. An open breaker therefore cannot be served by builtin.
 */

export type PriceUnit = 'per_second' | 'per_call' | 'per_image';

export type RoutingCandidate = {
  id: string;
  name: string;
  kind: 'image' | 'video';
  provider: string;
  enabled: boolean;
  sortWeight: number;
  priceAmount: number;
  priceUnit: PriceUnit;
  /** `providerFor(model).remote`, not the registry provider name. */
  remote: boolean;
  circuitOpen: boolean;
  /** Zero health is ineligible for automatic selection. */
  health: number;
  fallbackModelId: string | null;
};

export type RoutableModel = {
  id: string;
  name: string;
  kind: 'image' | 'video';
  provider: string;
  enabled: boolean;
  sortWeight: number;
  priceAmount: number;
  priceUnit: PriceUnit;
  fallbackModelId: string | null;
};

type RoutingInput = Omit<RoutingCandidate, 'health' | 'fallbackModelId'> & {
  /** Defaults to 0 while the circuit is open, otherwise 1. Zero is kept. */
  health?: number;
  fallbackModelId?: string | null;
};

/** `auto` is a selector only when the registry has no model with that id. */
export function isAutoModelRequest(modelId: string, registeredAutoExists: boolean): boolean {
  return modelId === 'auto' && !registeredAutoExists;
}

export function routingCandidate(input: RoutingInput): RoutingCandidate {
  return {
    id: input.id,
    name: input.name,
    kind: input.kind,
    provider: input.provider,
    enabled: input.enabled,
    sortWeight: input.sortWeight,
    priceAmount: input.priceAmount,
    priceUnit: input.priceUnit,
    remote: input.remote,
    circuitOpen: input.circuitOpen,
    health: input.health ?? (input.circuitOpen ? 0 : 1),
    fallbackModelId: normalizeFallbackId(input.fallbackModelId),
  };
}

export function toRoutingCandidate(
  model: RoutableModel,
  runtime: { remote: boolean; circuitOpen: boolean },
): RoutingCandidate {
  return routingCandidate({
    id: model.id,
    name: model.name,
    kind: model.kind,
    provider: model.provider,
    enabled: model.enabled,
    sortWeight: model.sortWeight,
    priceAmount: model.priceAmount,
    priceUnit: model.priceUnit,
    remote: runtime.remote,
    circuitOpen: runtime.circuitOpen,
    fallbackModelId: model.fallbackModelId,
  });
}

/**
 * Best enabled model of `kind`.
 * Lower `sortWeight` wins, then lower `priceAmount`, then id.
 * Plan duration and credit checks stay with the caller, after this pick.
 */
export function selectAutoModel(
  candidates: readonly RoutingCandidate[],
  kind: 'image' | 'video',
): RoutingCandidate | null {
  const eligible = candidates.filter((model) => isAutoEligible(model, kind));
  eligible.sort(compareRoute);
  return eligible[0] ?? null;
}

/**
 * Standby for a remote model whose circuit is already open.
 * Returns null when the standby is missing or not qualified. Callers must
 * keep the original `PROVIDER_BUSY` path in that case and must not run builtin.
 */
export function selectFallback(
  current: RoutingCandidate,
  fallback: RoutingCandidate | null,
): RoutingCandidate | null {
  if (!current.remote || !current.circuitOpen) return null;
  if (!fallback) return null;
  if (fallback.id === current.id) return null;
  if (!fallback.enabled) return null;
  if (fallback.kind !== current.kind) return null;
  if (fallback.provider === current.provider) return null;
  if (!fallback.remote) return null;
  if (fallback.circuitOpen) return null;
  if (fallback.priceUnit !== current.priceUnit) return null;
  if (!Number.isFinite(fallback.priceAmount) || !Number.isFinite(current.priceAmount)) return null;
  if (fallback.priceAmount > current.priceAmount) return null;
  return fallback;
}

/**
 * Failover is only the pre-run open circuit. Any error from the attempt
 * itself — content rejection, auth, rate limit, cancellation — stays put.
 */
export function circuitFailoverAllowed(input: {
  remote: boolean;
  circuitOpen: boolean;
  errorCode?: string | null;
}): boolean {
  if (input.errorCode) return false;
  return input.remote === true && input.circuitOpen === true;
}

/** Up to three display names of the same kind whose circuit is closed. */
export function alternativeNames(
  candidates: readonly RoutingCandidate[],
  kind: 'image' | 'video',
  limit = 3,
): string[] {
  const cap = Math.min(3, Math.max(0, Math.floor(limit)));
  return candidates
    .filter((model) => isNamedAlternative(model, kind))
    .sort(compareRoute)
    .slice(0, cap)
    .map((model) => model.name.trim());
}

export function unavailableModelMessage(names: readonly string[]): string {
  const shown = names.map((name) => name.trim()).filter((name) => name.length > 0).slice(0, 3);
  if (shown.length === 0) return '模型不存在或已下线';
  return `模型不存在或已下线，可改用：${shown.join('、')}`;
}

export type AffordableCandidate = {
  id: string;
  name: string;
  kind: 'image' | 'video';
  enabled: boolean;
  circuitOpen: boolean;
  sortWeight: number;
  priceAmount: number;
  cost: number;
  durationOk: boolean;
};

export type AffordableAlternativeInput = {
  kind: 'image' | 'video';
  excludeId: string;
  balance: number;
};

/**
 * Up to three display names the caller can still afford.
 * Same kind, enabled, circuit closed, duration accepted, and cost within balance.
 */
export function affordableAlternativeNames(
  candidates: readonly AffordableCandidate[],
  input: AffordableAlternativeInput,
): string[] {
  return candidates
    .filter((model) => isAffordableAlternative(model, input))
    .sort(compareAffordable)
    .slice(0, 3)
    .map((model) => model.name.trim());
}

export function insufficientCreditsMessage(names: readonly string[]): string {
  const shown = names.map((name) => name.trim()).filter((name) => name.length > 0).slice(0, 3);
  if (shown.length === 0) return '积分不足，请充值后再试';
  return `积分不足，请充值后再试，可改用：${shown.join('、')}`;
}

/** Reads `capabilities.fallbackModelId` from an object or a JSON string. */
export function readFallbackModelId(capabilities: unknown): string | null {
  const record = capabilitiesRecord(capabilities);
  return normalizeFallbackId(record?.fallbackModelId);
}

function isAutoEligible(model: RoutingCandidate, kind: 'image' | 'video'): boolean {
  if (model.kind !== kind || !model.enabled) return false;
  if (!(model.health > 0)) return false;
  if (model.remote && model.circuitOpen) return false;
  if (!Number.isFinite(model.sortWeight) || !Number.isFinite(model.priceAmount)) return false;
  return true;
}

function isNamedAlternative(model: RoutingCandidate, kind: 'image' | 'video'): boolean {
  return model.kind === kind && model.enabled && !model.circuitOpen && model.name.trim().length > 0;
}

function isAffordableAlternative(model: AffordableCandidate, input: AffordableAlternativeInput): boolean {
  return (
    model.kind === input.kind &&
    model.enabled &&
    !model.circuitOpen &&
    model.id !== input.excludeId &&
    model.name.trim().length > 0 &&
    model.durationOk === true &&
    Number.isFinite(model.cost) &&
    model.cost <= input.balance
  );
}

function compareRoute(a: RoutingCandidate, b: RoutingCandidate): number {
  if (a.sortWeight !== b.sortWeight) return a.sortWeight - b.sortWeight;
  if (a.priceAmount !== b.priceAmount) return a.priceAmount - b.priceAmount;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function compareAffordable(a: AffordableCandidate, b: AffordableCandidate): number {
  if (a.sortWeight !== b.sortWeight) return a.sortWeight - b.sortWeight;
  if (a.priceAmount !== b.priceAmount) return a.priceAmount - b.priceAmount;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function normalizeFallbackId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function capabilitiesRecord(capabilities: unknown): { fallbackModelId?: unknown } | null {
  if (!capabilities) return null;
  if (typeof capabilities === 'string') {
    try {
      return capabilitiesRecord(JSON.parse(capabilities) as unknown);
    } catch {
      return null;
    }
  }
  if (typeof capabilities === 'object') return capabilities as { fallbackModelId?: unknown };
  return null;
}
