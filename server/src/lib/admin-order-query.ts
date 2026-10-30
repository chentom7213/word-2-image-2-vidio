export const ADMIN_ORDER_STATUS_INVALID = '订单状态无效';

export const ADMIN_ORDER_LIMIT_INVALID = '订单条数需为 1 到 200 的整数';

export const ADMIN_ORDER_LIMIT_DEFAULT = 50;

const ADMIN_ORDER_LIMIT_MIN = 1;

const ADMIN_ORDER_LIMIT_MAX = 200;

const ADMIN_ORDER_STATUSES = ['pending', 'paid', 'failed', 'refunded', 'expired'] as const;

export type AdminOrderStatus = (typeof ADMIN_ORDER_STATUSES)[number];

/**
 * 管理端订单列表的 status 与 limit。
 * status 没传、null、空字符串不过滤；五种状态原样。其他值（含数组）无效。
 * limit 没传或 null 用 50；1 到 200 的整数和数字字符串原样。小数、超出、非整数不收成 200。
 * 状态无效优先于条数无效。
 */
export function parseAdminOrderQuery(query: { status?: unknown; limit?: unknown }): {
  status: AdminOrderStatus | null;
  limit: number;
  error: string | null;
} {
  const status = parseStatus(query.status);
  const limit = parseLimit(query.limit);
  if (status.error) return { status: null, limit: limit.limit, error: status.error };
  if (limit.error) return { status: status.status, limit: ADMIN_ORDER_LIMIT_DEFAULT, error: limit.error };
  return { status: status.status, limit: limit.limit, error: null };
}

function parseStatus(raw: unknown): { status: AdminOrderStatus | null; error: string | null } {
  if (raw === undefined || raw === null || raw === '') return { status: null, error: null };
  if (typeof raw === 'string' && isAdminOrderStatus(raw)) return { status: raw, error: null };
  return { status: null, error: ADMIN_ORDER_STATUS_INVALID };
}

function isAdminOrderStatus(value: string): value is AdminOrderStatus {
  return (ADMIN_ORDER_STATUSES as readonly string[]).includes(value);
}

function parseLimit(raw: unknown): { limit: number; error: string | null } {
  if (raw === undefined || raw === null) return { limit: ADMIN_ORDER_LIMIT_DEFAULT, error: null };
  const limit = boundedInteger(raw);
  if (limit === null) return { limit: ADMIN_ORDER_LIMIT_DEFAULT, error: ADMIN_ORDER_LIMIT_INVALID };
  return { limit, error: null };
}

function boundedInteger(raw: unknown): number | null {
  if (typeof raw === 'number') return inRange(raw);
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) return inRange(Number(raw));
  return null;
}

function inRange(value: number): number | null {
  if (!Number.isInteger(value) || value < ADMIN_ORDER_LIMIT_MIN || value > ADMIN_ORDER_LIMIT_MAX) return null;
  return value;
}
