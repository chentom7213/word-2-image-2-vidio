export const CANVAS_MAX_NODES = 300;

export const CANVAS_MAX_TEXT_LENGTH = 20_000;

export const CANVAS_TOO_MANY_NODES = '画布最多 300 个节点';

export const CANVAS_TEXT_TOO_LONG = '文本节点最长 20000 字';

export const CANVAS_NODE_POSITION_INVALID = '节点位置需在 -100000 到 100000 之间';

export const CANVAS_NODE_SIZE_INVALID = '节点尺寸需在 40 到 10000 之间';

export const CANVAS_VIEWPORT_POSITION_INVALID = '画布位置需在 -100000 到 100000 之间';

export const CANVAS_VIEWPORT_ZOOM_INVALID = '画布缩放需在 0.4 到 2 之间';

const CANVAS_MIN_POSITION = -100_000;

const CANVAS_MAX_POSITION = 100_000;

const CANVAS_MIN_SIZE = 40;

const CANVAS_MAX_SIZE = 10_000;

const CANVAS_MIN_ZOOM = 0.4;

const CANVAS_MAX_ZOOM = 2;

/** 按原文计长，不 trim。节点数优先于文本长度；刚好到上限、空文本、缺 text、text 非字符串都放行。 */
export function canvasDocumentProblem(nodes: readonly unknown[]): string | null {
  if (nodes.length > CANVAS_MAX_NODES) return CANVAS_TOO_MANY_NODES;
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const text = (node as { text?: unknown }).text;
    if (typeof text === 'string' && text.length > CANVAS_MAX_TEXT_LENGTH) return CANVAS_TEXT_TOO_LONG;
  }
  return null;
}

function numberOutOfRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && (!Number.isFinite(value) || value < min || value > max);
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

/** 节点按数组顺序先看完位置再看尺寸；两者都合法后再看视口。非 number 跳过，边界值放行。 */
export function canvasBoundsProblem(nodes: readonly unknown[], viewport: unknown): string | null {
  for (const node of nodes) {
    if (
      numberOutOfRange(field(node, 'x'), CANVAS_MIN_POSITION, CANVAS_MAX_POSITION) ||
      numberOutOfRange(field(node, 'y'), CANVAS_MIN_POSITION, CANVAS_MAX_POSITION)
    ) {
      return CANVAS_NODE_POSITION_INVALID;
    }
  }
  for (const node of nodes) {
    if (
      numberOutOfRange(field(node, 'w'), CANVAS_MIN_SIZE, CANVAS_MAX_SIZE) ||
      numberOutOfRange(field(node, 'h'), CANVAS_MIN_SIZE, CANVAS_MAX_SIZE)
    ) {
      return CANVAS_NODE_SIZE_INVALID;
    }
  }
  if (
    numberOutOfRange(field(viewport, 'x'), CANVAS_MIN_POSITION, CANVAS_MAX_POSITION) ||
    numberOutOfRange(field(viewport, 'y'), CANVAS_MIN_POSITION, CANVAS_MAX_POSITION)
  ) {
    return CANVAS_VIEWPORT_POSITION_INVALID;
  }
  if (numberOutOfRange(field(viewport, 'zoom'), CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM)) {
    return CANVAS_VIEWPORT_ZOOM_INVALID;
  }
  return null;
}
