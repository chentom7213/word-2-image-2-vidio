import { describe, expect, it } from 'vitest';
import { storedCostActual } from '../src/lib/stored-cost.js';

const STORED_COST_MAX = 2_147_483_647;

describe('storedCostActual', () => {
  it('范围内的安全整数原样返回', () => {
    expect(storedCostActual(0)).toBe(0);
    expect(storedCostActual(12)).toBe(12);
    expect(storedCostActual(STORED_COST_MAX)).toBe(STORED_COST_MAX);
    expect(Object.is(storedCostActual(-0), -0)).toBe(true);
  });

  it('小数不四舍五入', () => {
    expect(storedCostActual(0.1)).toBe(0);
    expect(storedCostActual(1.5)).toBe(0);
    expect(storedCostActual(1.9)).toBe(0);
    expect(storedCostActual(STORED_COST_MAX + 0.5)).toBe(0);
  });

  it('负数返回 0', () => {
    expect(storedCostActual(-1)).toBe(0);
    expect(storedCostActual(-0.1)).toBe(0);
    expect(storedCostActual(Number.MIN_SAFE_INTEGER)).toBe(0);
  });

  it('NaN 和 Infinity 返回 0', () => {
    expect(storedCostActual(Number.NaN)).toBe(0);
    expect(storedCostActual(Number.POSITIVE_INFINITY)).toBe(0);
    expect(storedCostActual(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('超出上限返回 0', () => {
    expect(storedCostActual(STORED_COST_MAX + 1)).toBe(0);
    expect(storedCostActual(Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it('字符串和 null 返回 0', () => {
    expect(storedCostActual('12')).toBe(0);
    expect(storedCostActual('0')).toBe(0);
    expect(storedCostActual('')).toBe(0);
    expect(storedCostActual(' 12 ')).toBe(0);
    expect(storedCostActual(null)).toBe(0);
    expect(storedCostActual(undefined)).toBe(0);
    expect(storedCostActual(true)).toBe(0);
    expect(storedCostActual(1n)).toBe(0);
  });
});
