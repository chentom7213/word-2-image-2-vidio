import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toMillis } from '../src/lib/dto.js';
import {
  CANVAS_MAX_NODES,
  CANVAS_MAX_TEXT_LENGTH,
  CANVAS_NODE_POSITION_INVALID,
  CANVAS_NODE_SIZE_INVALID,
  CANVAS_TEXT_TOO_LONG,
  CANVAS_TOO_MANY_NODES,
  CANVAS_VIEWPORT_POSITION_INVALID,
  CANVAS_VIEWPORT_ZOOM_INVALID,
  canvasBoundsProblem,
  canvasDocumentProblem,
} from '../src/lib/canvas-limit.js';

function nodes(count: number, text?: unknown) {
  return Array.from({ length: count }, () => ({ text }));
}

describe('canvasDocumentProblem', () => {
  it('超过', () => {
    expect(canvasDocumentProblem(nodes(CANVAS_MAX_NODES + 1, 'a'))).toBe(CANVAS_TOO_MANY_NODES);
    expect(canvasDocumentProblem(nodes(1, '字'.repeat(CANVAS_MAX_TEXT_LENGTH + 1)))).toBe(CANVAS_TEXT_TOO_LONG);
    expect(canvasDocumentProblem(nodes(1, `${'字'.repeat(CANVAS_MAX_TEXT_LENGTH)} `))).toBe(CANVAS_TEXT_TOO_LONG);
    const mixed = nodes(2, '短文本');
    mixed[1] = { text: '字'.repeat(CANVAS_MAX_TEXT_LENGTH + 1) };
    expect(canvasDocumentProblem(mixed)).toBe(CANVAS_TEXT_TOO_LONG);
  });

  it('刚好', () => {
    expect(canvasDocumentProblem(nodes(CANVAS_MAX_NODES, 'a'))).toBeNull();
    expect(canvasDocumentProblem(nodes(1, '字'.repeat(CANVAS_MAX_TEXT_LENGTH)))).toBeNull();
    expect(canvasDocumentProblem(nodes(1, ` ${'字'.repeat(CANVAS_MAX_TEXT_LENGTH - 1)}`))).toBeNull();
  });

  it('空文本', () => {
    expect(canvasDocumentProblem(nodes(1, ''))).toBeNull();
    expect(canvasDocumentProblem([{}])).toBeNull();
    expect(canvasDocumentProblem([{ id: 'n1' }])).toBeNull();
  });

  it('非字符串', () => {
    expect(canvasDocumentProblem(nodes(1, 20001))).toBeNull();
    expect(canvasDocumentProblem(nodes(1, null))).toBeNull();
    expect(canvasDocumentProblem(nodes(1, { length: CANVAS_MAX_TEXT_LENGTH + 1 }))).toBeNull();
    expect(canvasDocumentProblem([null, 1, 'text'])).toBeNull();
  });

  it('两者同时超限', () => {
    expect(
      canvasDocumentProblem(nodes(CANVAS_MAX_NODES + 1, ` ${'字'.repeat(CANVAS_MAX_TEXT_LENGTH)} `)),
    ).toBe(CANVAS_TOO_MANY_NODES);
  });
});

const inRange = { x: 0, y: 0, w: 40, h: 40 };
const inView = { x: 0, y: 0, zoom: 1 };

describe('canvasBoundsProblem', () => {
  it('超过', () => {
    expect(canvasBoundsProblem([{ ...inRange, x: -100_001 }], inView)).toBe(CANVAS_NODE_POSITION_INVALID);
    expect(canvasBoundsProblem([{ ...inRange, x: 100_001 }], inView)).toBe(CANVAS_NODE_POSITION_INVALID);
    expect(canvasBoundsProblem([{ ...inRange, y: -100_001 }], inView)).toBe(CANVAS_NODE_POSITION_INVALID);
    expect(canvasBoundsProblem([{ ...inRange, y: 100_001 }], inView)).toBe(CANVAS_NODE_POSITION_INVALID);
    expect(canvasBoundsProblem([{ ...inRange, w: 39 }], inView)).toBe(CANVAS_NODE_SIZE_INVALID);
    expect(canvasBoundsProblem([{ ...inRange, w: 10_001 }], inView)).toBe(CANVAS_NODE_SIZE_INVALID);
    expect(canvasBoundsProblem([{ ...inRange, h: 39 }], inView)).toBe(CANVAS_NODE_SIZE_INVALID);
    expect(canvasBoundsProblem([{ ...inRange, h: 10_001 }], inView)).toBe(CANVAS_NODE_SIZE_INVALID);
    expect(canvasBoundsProblem([inRange], { ...inView, x: -100_001 })).toBe(CANVAS_VIEWPORT_POSITION_INVALID);
    expect(canvasBoundsProblem([inRange], { ...inView, x: 100_001 })).toBe(CANVAS_VIEWPORT_POSITION_INVALID);
    expect(canvasBoundsProblem([inRange], { ...inView, y: -100_001 })).toBe(CANVAS_VIEWPORT_POSITION_INVALID);
    expect(canvasBoundsProblem([inRange], { ...inView, y: 100_001 })).toBe(CANVAS_VIEWPORT_POSITION_INVALID);
    expect(canvasBoundsProblem([inRange], { ...inView, zoom: 0.39 })).toBe(CANVAS_VIEWPORT_ZOOM_INVALID);
    expect(canvasBoundsProblem([inRange], { ...inView, zoom: 2.01 })).toBe(CANVAS_VIEWPORT_ZOOM_INVALID);
  });

  it('刚好', () => {
    expect(
      canvasBoundsProblem(
        [
          { x: -100_000, y: -100_000, w: 40, h: 40 },
          { x: 100_000, y: 100_000, w: 10_000, h: 10_000 },
        ],
        { x: -100_000, y: 100_000, zoom: 0.4 },
      ),
    ).toBeNull();
    expect(canvasBoundsProblem([inRange], { x: 100_000, y: -100_000, zoom: 2 })).toBeNull();
    expect(canvasBoundsProblem([{ x: '100001', y: null, w: false, h: undefined }], { x: '0', zoom: null })).toBeNull();
    expect(canvasBoundsProblem([null, 1, 'node'], undefined)).toBeNull();
  });

  it('NaN', () => {
    expect(canvasBoundsProblem([{ ...inRange, x: Number.NaN }], inView)).toBe(CANVAS_NODE_POSITION_INVALID);
    expect(canvasBoundsProblem([{ ...inRange, y: Number.NaN }], inView)).toBe(CANVAS_NODE_POSITION_INVALID);
    expect(canvasBoundsProblem([{ ...inRange, w: Number.NaN }], inView)).toBe(CANVAS_NODE_SIZE_INVALID);
    expect(canvasBoundsProblem([{ ...inRange, h: Number.NaN }], inView)).toBe(CANVAS_NODE_SIZE_INVALID);
    expect(canvasBoundsProblem([inRange], { ...inView, x: Number.NaN })).toBe(CANVAS_VIEWPORT_POSITION_INVALID);
    expect(canvasBoundsProblem([inRange], { ...inView, y: Number.NaN })).toBe(CANVAS_VIEWPORT_POSITION_INVALID);
    expect(canvasBoundsProblem([inRange], { ...inView, zoom: Number.NaN })).toBe(CANVAS_VIEWPORT_ZOOM_INVALID);
    expect(canvasBoundsProblem([{ ...inRange, x: Number.POSITIVE_INFINITY }], inView)).toBe(CANVAS_NODE_POSITION_INVALID);
    expect(canvasBoundsProblem([inRange], { ...inView, zoom: Number.NEGATIVE_INFINITY })).toBe(CANVAS_VIEWPORT_ZOOM_INVALID);
  });

  it('先遇到的那一条', () => {
    expect(
      canvasBoundsProblem(
        [
          { x: 'skip', y: 0, w: 39, h: 1 },
          { ...inRange, y: 100_001 },
        ],
        { x: -100_001, y: 100_001, zoom: 9 },
      ),
    ).toBe(CANVAS_NODE_POSITION_INVALID);
    expect(
      canvasBoundsProblem([{ x: -100_000, y: 100_000, w: 10_001, h: 39 }], { x: 100_001, y: -100_001, zoom: 0.1 }),
    ).toBe(CANVAS_NODE_SIZE_INVALID);
    expect(canvasBoundsProblem([inRange], { y: 100_001, zoom: 2.5 })).toBe(CANVAS_VIEWPORT_POSITION_INVALID);
  });
});

describe('canvas updatedAt', () => {
  it('reads the stored datetime as UTC', () => {
    const source = readFileSync(new URL('../src/routes/canvas.ts', import.meta.url), 'utf8');
    expect(source).toContain('updatedAt: toMillis(row.updated_at)');
    expect(source).not.toContain('new Date(row.updated_at)');
    expect(toMillis('2026-10-27 06:00:00')).toBe(Date.parse('2026-10-27T06:00:00Z'));
  });
});
