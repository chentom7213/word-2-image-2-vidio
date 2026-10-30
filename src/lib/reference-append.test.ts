// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import type { Asset } from './types.ts';
import { appendReferenceAssets } from './reference-append.ts';

function asset(id: string): Asset {
  return { id, kind: 'image', name: `${id}.png`, url: `/assets/${id}`, size: 12 };
}

function ids(assets: readonly Asset[]): string[] {
  return assets.map((item) => item.id);
}

describe('appendReferenceAssets', () => {
  it('空列表加两个', () => {
    const current: Asset[] = [];
    const incoming = [asset('a'), asset('b')];
    const result = appendReferenceAssets(current, incoming, 9);

    expect(ids(result)).toEqual(['a', 'b']);
    expect(result).not.toBe(current);
    expect(current).toEqual([]);
    expect(ids(incoming)).toEqual(['a', 'b']);
  });

  it('已有 1 个再加不重复的', () => {
    const current = [asset('a')];
    const incoming = [asset('b')];
    const result = appendReferenceAssets(current, incoming, 9);

    expect(ids(result)).toEqual(['a', 'b']);
    expect(result[0]).toBe(current[0]);
    expect(result[1]).toBe(incoming[0]);
    expect(ids(current)).toEqual(['a']);
    expect(ids(incoming)).toEqual(['b']);
  });

  it('重复 id 不加', () => {
    const current = [asset('a'), asset('b')];
    const incoming = [asset('b'), asset('c')];
    const result = appendReferenceAssets(current, incoming, 9);

    expect(ids(result)).toEqual(['a', 'b', 'c']);
    expect(result[0]).toBe(current[0]);
    expect(result[1]).toBe(current[1]);
    expect(result[2]).toBe(incoming[1]);
    expect(ids(current)).toEqual(['a', 'b']);
    expect(ids(incoming)).toEqual(['b', 'c']);
  });

  it('max 为 9 且已有 8 个时只再收 1 个', () => {
    const current = Array.from({ length: 8 }, (_, index) => asset(`have-${index}`));
    const incoming = [asset('new-1'), asset('new-2')];
    const result = appendReferenceAssets(current, incoming, 9);

    expect(result).toHaveLength(9);
    expect(ids(result).slice(0, 8)).toEqual(ids(current));
    expect(result[8]).toBe(incoming[0]);
    expect(current).toHaveLength(8);
    expect(ids(incoming)).toEqual(['new-1', 'new-2']);
  });

  it('已经 9 个时不再加', () => {
    const current = Array.from({ length: 9 }, (_, index) => asset(`have-${index}`));
    const incoming = [asset('new-1'), asset('new-2')];
    const result = appendReferenceAssets(current, incoming, 9);

    expect(result).not.toBe(current);
    expect(ids(result)).toEqual(ids(current));
    expect(result[0]).toBe(current[0]);
    expect(result[8]).toBe(current[8]);
    expect(current).toHaveLength(9);
    expect(ids(incoming)).toEqual(['new-1', 'new-2']);
  });

  it('incoming 为空时返回 current 的副本', () => {
    const current = [asset('a')];
    const incoming: Asset[] = [];
    const result = appendReferenceAssets(current, incoming, 9);

    expect(result).not.toBe(current);
    expect(result).toEqual(current);
    expect(result[0]).toBe(current[0]);
    expect(current).toHaveLength(1);
    expect(incoming).toEqual([]);
  });

  it('不修改入参数组', () => {
    const current = [asset('a')];
    const incoming = [asset('a'), asset('b')];
    const currentBefore = [...current];
    const incomingBefore = [...incoming];

    const result = appendReferenceAssets(current, incoming, 1);

    expect(current).toEqual(currentBefore);
    expect(incoming).toEqual(incomingBefore);
    expect(current[0]).toBe(currentBefore[0]);
    expect(incoming[0]).toBe(incomingBefore[0]);
    expect(incoming[1]).toBe(incomingBefore[1]);
    expect(result).not.toBe(current);
    expect(result).not.toBe(incoming);
    expect(ids(result)).toEqual(['a']);
  });
});
