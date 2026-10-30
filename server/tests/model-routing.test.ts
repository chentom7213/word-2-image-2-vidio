import { describe, expect, it } from 'vitest';
import {
  alternativeNames,
  circuitFailoverAllowed,
  isAutoModelRequest,
  readFallbackModelId,
  routingCandidate,
  selectAutoModel,
  selectFallback,
  toRoutingCandidate,
  unavailableModelMessage,
  type RoutingCandidate,
} from '../src/services/model-routing.js';
import { toStoredModel, type ModelRow } from '../src/services/models.js';

function candidate(overrides: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    id: 'm',
    name: 'M',
    kind: 'video',
    provider: 'acme',
    enabled: true,
    sortWeight: 10,
    priceAmount: 20,
    priceUnit: 'per_second',
    remote: true,
    circuitOpen: false,
    health: 1,
    fallbackModelId: null,
    ...overrides,
  };
}

function row(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    id: 'remote-video',
    provider: 'acme',
    display_name: 'Remote',
    kind: 'video',
    price_unit: 'per_second',
    price_amount: 40,
    max_duration: 8,
    resolutions: null,
    capabilities: { fallbackModelId: ' backup ' },
    provider_model: 'vendor-model',
    enabled: 1,
    sort_weight: 2,
    ...overrides,
  };
}

describe('automatic model selection', () => {
  it('treats auto as a selector only when that id is not registered', () => {
    expect(isAutoModelRequest('auto', false)).toBe(true);
    expect(isAutoModelRequest('auto', true)).toBe(false);
    expect(isAutoModelRequest('seedance-2', false)).toBe(false);
    expect(isAutoModelRequest('Auto', false)).toBe(false);
  });

  it('ranks a lower sort weight ahead of a cheaper model', () => {
    const quality = candidate({ id: 'quality', sortWeight: 1, priceAmount: 100 });
    const cheap = candidate({ id: 'cheap', sortWeight: 2, priceAmount: 1 });
    expect(selectAutoModel([cheap, quality], 'video')?.id).toBe('quality');
  });

  it('breaks a sort-weight tie by price and then id', () => {
    const pricey = candidate({ id: 'b', sortWeight: 1, priceAmount: 30 });
    const later = candidate({ id: 'c', sortWeight: 1, priceAmount: 10 });
    const earlier = candidate({ id: 'a', sortWeight: 1, priceAmount: 10 });
    expect(selectAutoModel([pricey, later, earlier], 'video')?.id).toBe('a');
  });

  it('keeps only enabled models of the requested kind', () => {
    const image = candidate({ id: 'image', kind: 'image', sortWeight: 0, priceAmount: 1 });
    const disabled = candidate({ id: 'off', enabled: false, sortWeight: 0, priceAmount: 1 });
    const video = candidate({ id: 'video', sortWeight: 4, priceAmount: 50 });
    expect(selectAutoModel([image, disabled, video], 'video')?.id).toBe('video');
  });

  it('skips health 0 and a remote model whose circuit is open', () => {
    const sick = candidate({
      id: 'sick',
      remote: false,
      provider: 'builtin',
      circuitOpen: false,
      health: 0,
      sortWeight: 0,
      priceAmount: 1,
    });
    const open = candidate({
      id: 'open',
      remote: true,
      circuitOpen: true,
      health: 1,
      sortWeight: 1,
      priceAmount: 1,
    });
    const healthy = candidate({ id: 'healthy', sortWeight: 5, priceAmount: 80, health: 1, circuitOpen: false });
    expect(selectAutoModel([sick, open, healthy], 'video')?.id).toBe('healthy');
  });

  it('can select a non-remote model, but does not prefer it over a healthier remote', () => {
    const builtin = candidate({
      id: 'local',
      provider: 'seedance',
      remote: false,
      circuitOpen: false,
      health: 1,
      sortWeight: 5,
      priceAmount: 1,
    });
    const remote = candidate({
      id: 'remote',
      remote: true,
      circuitOpen: false,
      health: 1,
      sortWeight: 1,
      priceAmount: 99,
    });
    expect(selectAutoModel([builtin, remote], 'video')?.id).toBe('remote');

    const tripped = candidate({
      id: 'tripped',
      remote: true,
      circuitOpen: true,
      health: 0,
      sortWeight: 0,
      priceAmount: 1,
    });
    expect(selectAutoModel([tripped, builtin], 'video')?.id).toBe('local');
  });

  it('returns null when nothing is eligible', () => {
    expect(selectAutoModel([candidate({ enabled: false })], 'video')).toBeNull();
  });

  it('derives health from the circuit unless the caller sets it', () => {
    const model = {
      id: 'm',
      name: 'M',
      kind: 'video' as const,
      provider: 'acme',
      enabled: true,
      sortWeight: 1,
      priceAmount: 10,
      priceUnit: 'per_call' as const,
      fallbackModelId: null,
    };
    expect(toRoutingCandidate(model, { remote: true, circuitOpen: true }).health).toBe(0);
    expect(toRoutingCandidate(model, { remote: false, circuitOpen: false }).health).toBe(1);
    expect(routingCandidate({ ...model, remote: false, circuitOpen: false, health: 0 }).health).toBe(0);
  });
});

describe('remote circuit fallback', () => {
  const current = candidate({
    id: 'primary',
    provider: 'acme',
    remote: true,
    circuitOpen: true,
    priceAmount: 40,
    priceUnit: 'per_call',
    fallbackModelId: 'standby',
  });

  const standby = candidate({
    id: 'standby',
    name: 'Standby',
    provider: 'beta',
    remote: true,
    circuitOpen: false,
    priceAmount: 40,
    priceUnit: 'per_call',
  });

  it('accepts an enabled remote standby of the same kind, unit, and price', () => {
    expect(selectFallback(current, standby)).toBe(standby);
    expect(selectFallback(current, { ...standby, priceAmount: 39 })?.id).toBe('standby');
  });

  it('rejects builtin and every other unqualified standby', () => {
    expect(selectFallback(current, { ...standby, remote: false, provider: 'seedance' })).toBeNull();
    expect(selectFallback(current, null)).toBeNull();
    expect(selectFallback(current, { ...standby, enabled: false })).toBeNull();
    expect(selectFallback(current, { ...standby, kind: 'image' })).toBeNull();
    expect(selectFallback(current, { ...standby, provider: 'acme' })).toBeNull();
    expect(selectFallback(current, { ...standby, id: 'primary' })).toBeNull();
    expect(selectFallback(current, { ...standby, circuitOpen: true })).toBeNull();
    expect(selectFallback(current, { ...standby, priceUnit: 'per_second' })).toBeNull();
    expect(selectFallback(current, { ...standby, priceAmount: 41 })).toBeNull();
    expect(selectFallback({ ...current, remote: false }, standby)).toBeNull();
    expect(selectFallback({ ...current, circuitOpen: false }, standby)).toBeNull();
  });

  it('does not fail over on content, auth, rate-limit, or cancellation errors', () => {
    const open = { remote: true, circuitOpen: true };
    expect(circuitFailoverAllowed(open)).toBe(true);
    expect(circuitFailoverAllowed({ remote: false, circuitOpen: true })).toBe(false);
    expect(circuitFailoverAllowed({ remote: true, circuitOpen: false })).toBe(false);
    for (const errorCode of ['CONTENT_REJECTED', 'PROVIDER_AUTH', 'PROVIDER_BUSY', 'CANCELLED', 'TOO_MANY']) {
      expect(circuitFailoverAllowed({ ...open, errorCode })).toBe(false);
    }
  });
});

describe('unavailable model suggestions', () => {
  const models = [
    candidate({ id: 'c', name: 'Gamma', sortWeight: 3, priceAmount: 5, circuitOpen: false }),
    candidate({ id: 'a', name: 'Alpha', sortWeight: 1, priceAmount: 50, circuitOpen: false }),
    candidate({ id: 'b', name: 'Beta', sortWeight: 1, priceAmount: 10, circuitOpen: false }),
    candidate({ id: 'open', name: 'Open', sortWeight: 0, priceAmount: 1, circuitOpen: true }),
    candidate({ id: 'off', name: 'Off', sortWeight: 0, priceAmount: 1, enabled: false, circuitOpen: false }),
    candidate({ id: 'image', name: 'Image', kind: 'image', sortWeight: 0, priceAmount: 1, circuitOpen: false }),
    candidate({ id: 'd', name: 'Delta', sortWeight: 4, priceAmount: 1, circuitOpen: false }),
  ];

  it('keeps at most three same-kind names whose circuit is closed', () => {
    expect(alternativeNames(models, 'video', 10)).toEqual(['Beta', 'Alpha', 'Gamma']);
    expect(alternativeNames(models, 'image')).toEqual(['Image']);
  });

  it('keeps the original prefix and appends at most three names', () => {
    expect(unavailableModelMessage([])).toBe('模型不存在或已下线');
    expect(unavailableModelMessage(['  '])).toBe('模型不存在或已下线');
    expect(unavailableModelMessage(['Alpha', 'Beta', 'Gamma', 'Delta'])).toBe(
      '模型不存在或已下线，可改用：Alpha、Beta、Gamma',
    );
  });
});

describe('fallbackModelId capabilities', () => {
  it('reads a trimmed string from an object or JSON text', () => {
    expect(readFallbackModelId({ fallbackModelId: ' standby ' })).toBe('standby');
    expect(readFallbackModelId('{"fallbackModelId":"beta"}')).toBe('beta');
    expect(readFallbackModelId({ fallbackModelId: '' })).toBeNull();
    expect(readFallbackModelId({ fallbackModelId: 12 })).toBeNull();
    expect(readFallbackModelId('not-json')).toBeNull();
    expect(readFallbackModelId(null)).toBeNull();
  });

  it('copies fallback, sort weight, and enabled onto the stored model without a query', () => {
    const stored = toStoredModel(row());
    expect(stored.fallbackModelId).toBe('backup');
    expect(stored.sortWeight).toBe(2);
    expect(stored.enabled).toBe(true);
    expect(stored.priceAmount).toBe(40);

    const disabled = toStoredModel(row({ enabled: 0, capabilities: '{"fallbackModelId":"beta"}', sort_weight: 7 }));
    expect(disabled.enabled).toBe(false);
    expect(disabled.fallbackModelId).toBe('beta');
    expect(disabled.sortWeight).toBe(7);
  });
});
