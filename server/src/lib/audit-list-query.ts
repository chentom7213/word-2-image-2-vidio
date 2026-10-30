import { auditBeforeId } from '../services/audit-page.js';

export const AUDIT_LIST_LIMIT_INVALID = '审计条数需为 1 到 500 的整数';
export const AUDIT_LIST_ACTION_TOO_LONG = '审计动作最长 80 字';
export const AUDIT_LIST_TARGET_TOO_LONG = '审计对象最长 120 字';
export const AUDIT_LIST_USER_ID_TOO_LONG = '用户编号最长 36 字';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_ACTION = 80;
const MAX_TARGET = 120;
const MAX_USER_ID = 36;

export type AuditListQueryInput = {
  limit?: unknown;
  action?: unknown;
  target?: unknown;
  userId?: unknown;
  before?: unknown;
};

export type AuditListQueryResult =
  | {
      error: null;
      limit: number;
      action: string | null;
      target: string | null;
      userId: string | null;
      beforeId: string | null;
    }
  | {
      error: string;
      limit: null;
      action: null;
      target: null;
      userId: null;
      beforeId: null;
    };

/**
 * 审计列表查询。limit 缺省为 50，只接受 1 到 500 的整数，数字字符串可以，其余值不改成 50。
 * action、target、userId 没传、null、空字符串表示不过滤；不 trim，按原文计长。
 * 超长、数组和非字符串用同一句。before 交给 auditBeforeId，数组也是无效游标。
 * 多个错误只返回第一个：limit、action、target、userId、before。
 */
export function parseAuditListQuery(query: AuditListQueryInput): AuditListQueryResult {
  const limit = readLimit(query.limit);
  if (limit.error) return invalid(limit.error);
  const action = readText(query.action, MAX_ACTION, AUDIT_LIST_ACTION_TOO_LONG);
  if (action.error) return invalid(action.error);
  const target = readText(query.target, MAX_TARGET, AUDIT_LIST_TARGET_TOO_LONG);
  if (target.error) return invalid(target.error);
  const userId = readText(query.userId, MAX_USER_ID, AUDIT_LIST_USER_ID_TOO_LONG);
  if (userId.error) return invalid(userId.error);
  const before = readBefore(query.before);
  if (before.error) return invalid(before.error);
  return {
    error: null,
    limit: limit.value,
    action: action.value,
    target: target.value,
    userId: userId.value,
    beforeId: before.value,
  };
}

function invalid(error: string): AuditListQueryResult {
  return { error, limit: null, action: null, target: null, userId: null, beforeId: null };
}

function readLimit(raw: unknown): { value: number; error: null } | { value: null; error: string } {
  if (raw === undefined || raw === null || raw === '') return { value: DEFAULT_LIMIT, error: null };
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= MAX_LIMIT) {
    return { value: raw, error: null };
  }
  if (typeof raw === 'string' && /^[1-9]\d*$/.test(raw)) {
    const value = Number(raw);
    if (value >= 1 && value <= MAX_LIMIT) return { value, error: null };
  }
  return { value: null, error: AUDIT_LIST_LIMIT_INVALID };
}

function readText(
  raw: unknown,
  maxLength: number,
  invalidMessage: string,
): { value: string | null; error: null } | { value: null; error: string } {
  if (raw === undefined || raw === null || raw === '') return { value: null, error: null };
  if (typeof raw !== 'string' || raw.length > maxLength) return { value: null, error: invalidMessage };
  return { value: raw, error: null };
}

function readBefore(raw: unknown): { value: string | null; error: null } | { value: null; error: string } {
  if (typeof raw !== 'string') {
    if (raw === undefined || raw === null) return { value: null, error: null };
    return { value: null, error: '审计游标无效' };
  }
  const cursor = auditBeforeId(raw);
  if (!cursor) return { value: null, error: null };
  if ('error' in cursor) return { value: null, error: cursor.error };
  return { value: cursor.id, error: null };
}
