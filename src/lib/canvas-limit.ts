const TOO_MANY_NODES = '画布最多 300 个节点';
const MAX_CANVAS_NODES = 300;
const TEXT_TOO_LONG = '文本节点最长 20000 字';
const MAX_CANVAS_TEXT_LENGTH = 20000;

/** More than 300 nodes cannot be saved. Otherwise any raw text longer than 20000 characters cannot be saved. */
export function canvasDocumentProblem(nodes: readonly { text?: string }[]): string | null {
  if (nodes.length > MAX_CANVAS_NODES) return TOO_MANY_NODES;
  for (const node of nodes) {
    if ((node.text ?? '').length > MAX_CANVAS_TEXT_LENGTH) return TEXT_TOO_LONG;
  }
  return null;
}

const NODE_POSITION_RANGE = '节点位置需在 -100000 到 100000 之间';
const NODE_SIZE_RANGE = '节点尺寸需在 40 到 10000 之间';
const CANVAS_POSITION_RANGE = '画布位置需在 -100000 到 100000 之间';
const CANVAS_ZOOM_RANGE = '画布缩放需在 0.4 到 2 之间';
const MIN_CANVAS_COORDINATE = -100000;
const MAX_CANVAS_COORDINATE = 100000;
const MIN_NODE_SIZE = 40;
const MAX_NODE_SIZE = 10000;
const MIN_CANVAS_ZOOM = 0.4;
const MAX_CANVAS_ZOOM = 2;

type BoundsNode = { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
type BoundsViewport = { x?: unknown; y?: unknown; zoom?: unknown };

function isOutsideNumericRange(value: unknown, min: number, max: number) {
  return typeof value === 'number' && (!Number.isFinite(value) || value < min || value > max);
}

/** Every node position, then every node size, then viewport position, then zoom. Non-numbers are ignored. */
export function canvasBoundsProblem(nodes: readonly BoundsNode[], viewport: BoundsViewport): string | null {
  for (const node of nodes) {
    if (
      isOutsideNumericRange(node.x, MIN_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE) ||
      isOutsideNumericRange(node.y, MIN_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE)
    ) {
      return NODE_POSITION_RANGE;
    }
  }
  for (const node of nodes) {
    if (
      isOutsideNumericRange(node.w, MIN_NODE_SIZE, MAX_NODE_SIZE) ||
      isOutsideNumericRange(node.h, MIN_NODE_SIZE, MAX_NODE_SIZE)
    ) {
      return NODE_SIZE_RANGE;
    }
  }
  if (
    isOutsideNumericRange(viewport.x, MIN_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE) ||
    isOutsideNumericRange(viewport.y, MIN_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE)
  ) {
    return CANVAS_POSITION_RANGE;
  }
  if (isOutsideNumericRange(viewport.zoom, MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM)) return CANVAS_ZOOM_RANGE;
  return null;
}
