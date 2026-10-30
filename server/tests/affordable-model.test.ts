import { describe, expect, it } from 'vitest';
import {
  affordableAlternativeNames,
  insufficientCreditsMessage,
} from '../src/services/model-routing.js';

type AffordableCandidate = {
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

function candidate(overrides: Partial<AffordableCandidate> = {}): AffordableCandidate {
  return {
    id: 'ok',
    name: 'Ok',
    kind: 'video',
    enabled: true,
    circuitOpen: false,
    sortWeight: 10,
    priceAmount: 10,
    cost: 10,
    durationOk: true,
    ...overrides,
  };
}

const input = { kind: 'video' as const, excludeId: 'current', balance: 20 };

describe('affordable model alternatives', () => {
  it('drops expensive, offline, open-circuit, rejected-duration, and the current model', () => {
    const names = affordableAlternativeNames(
      [
        candidate({ id: 'dear', name: '贵的', cost: 21, sortWeight: 0, priceAmount: 1 }),
        candidate({ id: 'off', name: '已下线', enabled: false, cost: 1, sortWeight: 0, priceAmount: 1 }),
        candidate({ id: 'open', name: '熔断', circuitOpen: true, cost: 1, sortWeight: 0, priceAmount: 1 }),
        candidate({ id: 'long', name: '时长', durationOk: false, cost: 1, sortWeight: 0, priceAmount: 1 }),
        candidate({ id: 'current', name: '当前', cost: 1, sortWeight: 0, priceAmount: 1 }),
        candidate({ id: 'image', name: '图片', kind: 'image', cost: 1, sortWeight: 0, priceAmount: 1 }),
        candidate({ id: 'blank', name: '   ', cost: 1, sortWeight: 0, priceAmount: 1 }),
        candidate({ id: 'nan', name: '无效花费', cost: Number.NaN, sortWeight: 0, priceAmount: 1 }),
        candidate({ id: 'fit', name: '  刚好  ', cost: 20, sortWeight: 5, priceAmount: 9 }),
      ],
      input,
    );

    expect(names).toEqual(['刚好']);
  });

  it('keeps only the first three after sort weight, price, then id', () => {
    const names = affordableAlternativeNames(
      [
        candidate({ id: 'e', name: 'Echo', sortWeight: 3, priceAmount: 1, cost: 1 }),
        candidate({ id: 'c', name: 'Gamma', sortWeight: 2, priceAmount: 1, cost: 1 }),
        candidate({ id: 'b', name: 'Beta', sortWeight: 1, priceAmount: 30, cost: 19 }),
        candidate({ id: 'd', name: 'Delta', sortWeight: 1, priceAmount: 10, cost: 10 }),
        candidate({ id: 'a', name: 'Alpha', sortWeight: 1, priceAmount: 10, cost: 8 }),
        candidate({ id: 'current', name: '当前', sortWeight: 0, priceAmount: 1, cost: 1 }),
      ],
      input,
    );

    expect(names).toEqual(['Alpha', 'Delta', 'Beta']);
  });

  it('keeps the original sentence when no alternative name can be shown', () => {
    expect(insufficientCreditsMessage([])).toBe('积分不足，请充值后再试');
    expect(insufficientCreditsMessage(['', '   '])).toBe('积分不足，请充值后再试');
    expect(insufficientCreditsMessage(affordableAlternativeNames([], input))).toBe('积分不足，请充值后再试');
  });

  it('appends at most three trimmed names with ideographic commas', () => {
    expect(insufficientCreditsMessage([' Alpha ', '', 'Beta', 'Gamma', 'Delta'])).toBe(
      '积分不足，请充值后再试，可改用：Alpha、Beta、Gamma',
    );
  });
});
