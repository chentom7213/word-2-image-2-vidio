// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { canvasBoundsProblem, canvasDocumentProblem } from './canvas-limit.ts';

describe('canvasDocumentProblem', () => {
  it('returns the node limit when there are more than 300 nodes', () => {
    expect(canvasDocumentProblem(Array.from({ length: 301 }, () => ({})))).toBe('画布最多 300 个节点');
  });

  it('returns the text limit when any raw text is longer than 20000', () => {
    expect(canvasDocumentProblem([{ text: '字'.repeat(20001) }])).toBe('文本节点最长 20000 字');
    expect(canvasDocumentProblem([{ text: 'ok' }, { text: `${'字'.repeat(20000)} ` }])).toBe('文本节点最长 20000 字');
  });

  it('returns null at exactly 300 nodes, exactly 20000 characters, empty text, and missing text', () => {
    expect(canvasDocumentProblem(Array.from({ length: 300 }, () => ({ text: '画布' })))).toBeNull();
    expect(canvasDocumentProblem([{ text: '字'.repeat(20000) }])).toBeNull();
    expect(canvasDocumentProblem([{ text: '' }])).toBeNull();
    expect(canvasDocumentProblem([{}])).toBeNull();
    expect(canvasDocumentProblem([{ text: undefined }])).toBeNull();
  });

  it('returns the node limit when both the node count and text length are over the limit', () => {
    expect(canvasDocumentProblem(Array.from({ length: 301 }, () => ({ text: '字'.repeat(20001) })))).toBe(
      '画布最多 300 个节点',
    );
  });
});

describe('canvasBoundsProblem', () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  const node = { x: 0, y: 0, w: 100, h: 100 };

  it('returns the matching limit when a number is outside the range', () => {
    expect(canvasBoundsProblem([{ ...node, x: -100001 }], viewport)).toBe('节点位置需在 -100000 到 100000 之间');
    expect(canvasBoundsProblem([{ ...node, y: 100001 }], viewport)).toBe('节点位置需在 -100000 到 100000 之间');
    expect(canvasBoundsProblem([{ ...node, w: 39 }], viewport)).toBe('节点尺寸需在 40 到 10000 之间');
    expect(canvasBoundsProblem([{ ...node, h: 10001 }], viewport)).toBe('节点尺寸需在 40 到 10000 之间');
    expect(canvasBoundsProblem([node], { ...viewport, x: -100001 })).toBe('画布位置需在 -100000 到 100000 之间');
    expect(canvasBoundsProblem([node], { ...viewport, y: 100001 })).toBe('画布位置需在 -100000 到 100000 之间');
    expect(canvasBoundsProblem([node], { ...viewport, zoom: 0.39 })).toBe('画布缩放需在 0.4 到 2 之间');
    expect(canvasBoundsProblem([node], { ...viewport, zoom: 2.01 })).toBe('画布缩放需在 0.4 到 2 之间');
  });

  it('returns null at the exact bounds', () => {
    expect(
      canvasBoundsProblem(
        [
          { x: -100000, y: 100000, w: 40, h: 10000 },
          { x: 100000, y: -100000, w: 10000, h: 40 },
        ],
        { x: -100000, y: 100000, zoom: 0.4 },
      ),
    ).toBeNull();
    expect(canvasBoundsProblem([node], { x: 100000, y: -100000, zoom: 2 })).toBeNull();
  });

  it('returns a limit for NaN and skips values that are not numbers', () => {
    expect(canvasBoundsProblem([{ ...node, x: Number.NaN }], viewport)).toBe('节点位置需在 -100000 到 100000 之间');
    expect(canvasBoundsProblem([{ ...node, h: Number.NaN }], viewport)).toBe('节点尺寸需在 40 到 10000 之间');
    expect(canvasBoundsProblem([node], { ...viewport, y: Number.NaN })).toBe('画布位置需在 -100000 到 100000 之间');
    expect(canvasBoundsProblem([node], { ...viewport, zoom: Number.NaN })).toBe('画布缩放需在 0.4 到 2 之间');
    expect(
      canvasBoundsProblem([{ x: '100001', y: null, w: undefined, h: false }], { x: '1', y: undefined, zoom: null }),
    ).toBeNull();
  });

  it('returns the first problem in scan order', () => {
    expect(canvasBoundsProblem([{ x: -100001, y: 0, w: 39, h: 40 }], { x: 100001, y: 0, zoom: 3 })).toBe(
      '节点位置需在 -100000 到 100000 之间',
    );
    expect(
      canvasBoundsProblem(
        [
          { x: 0, y: 0, w: 39, h: 40 },
          { x: 100001, y: 0, w: 40, h: 40 },
        ],
        { x: 100001, y: 0, zoom: 3 },
      ),
    ).toBe('节点位置需在 -100000 到 100000 之间');
    expect(
      canvasBoundsProblem(
        [
          { x: 0, y: 0, w: 40, h: 40 },
          { x: 0, y: 0, w: 39, h: 10001 },
        ],
        { x: -100001, y: 0, zoom: 0.1 },
      ),
    ).toBe('节点尺寸需在 40 到 10000 之间');
    expect(canvasBoundsProblem([node], { x: 100001, y: -100001, zoom: 3 })).toBe('画布位置需在 -100000 到 100000 之间');
  });
});
