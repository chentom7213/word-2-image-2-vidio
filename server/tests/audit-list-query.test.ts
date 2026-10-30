import { describe, expect, it } from 'vitest';
import {
  AUDIT_LIST_ACTION_TOO_LONG,
  AUDIT_LIST_LIMIT_INVALID,
  AUDIT_LIST_TARGET_TOO_LONG,
  AUDIT_LIST_USER_ID_TOO_LONG,
  parseAuditListQuery,
} from '../src/lib/audit-list-query.js';

const empty = {
  error: null,
  limit: 50,
  action: null,
  target: null,
  userId: null,
  beforeId: null,
};

describe('parseAuditListQuery', () => {
  it('空', () => {
    expect(parseAuditListQuery({})).toEqual(empty);
    expect(parseAuditListQuery({ limit: undefined, action: undefined, target: undefined, userId: undefined, before: undefined })).toEqual(empty);
    expect(parseAuditListQuery({ limit: null, action: null, target: null, userId: null, before: null })).toEqual(empty);
    expect(parseAuditListQuery({ limit: '', action: '', target: '', userId: '', before: '' })).toEqual(empty);
  });

  it('合法上限', () => {
    const action = ` ${'动'.repeat(78)} `;
    const target = ` ${'象'.repeat(118)} `;
    const userId = ` ${'户'.repeat(34)} `;
    const before = '1'.repeat(19);
    expect(action).toHaveLength(80);
    expect(target).toHaveLength(120);
    expect(userId).toHaveLength(36);
    expect(parseAuditListQuery({ limit: 1, action: '  task.create  ', target: ' 目标 ', userId: ' user ' })).toEqual({
      error: null,
      limit: 1,
      action: '  task.create  ',
      target: ' 目标 ',
      userId: ' user ',
      beforeId: null,
    });
    expect(parseAuditListQuery({ limit: '500', action, target, userId, before })).toEqual({
      error: null,
      limit: 500,
      action,
      target,
      userId,
      beforeId: before,
    });
    expect(parseAuditListQuery({ limit: 500 })).toMatchObject({ error: null, limit: 500 });
    expect(parseAuditListQuery({ limit: '1' })).toMatchObject({ error: null, limit: 1 });
    expect(parseAuditListQuery({ before: '42' })).toMatchObject({ error: null, beforeId: '42' });
  });

  it('超长', () => {
    const action = ` ${'动'.repeat(80)}`;
    const target = '象'.repeat(121);
    const userId = '户'.repeat(37);
    expect(action).toHaveLength(81);
    expect(action.trim()).toHaveLength(80);
    expect(parseAuditListQuery({ limit: 0 })).toEqual({
      error: AUDIT_LIST_LIMIT_INVALID,
      limit: null,
      action: null,
      target: null,
      userId: null,
      beforeId: null,
    });
    expect(parseAuditListQuery({ limit: 501 }).error).toBe(AUDIT_LIST_LIMIT_INVALID);
    expect(parseAuditListQuery({ limit: -1 }).error).toBe(AUDIT_LIST_LIMIT_INVALID);
    expect(parseAuditListQuery({ limit: 1.5 }).error).toBe(AUDIT_LIST_LIMIT_INVALID);
    expect(parseAuditListQuery({ limit: '1.5' }).error).toBe(AUDIT_LIST_LIMIT_INVALID);
    expect(parseAuditListQuery({ limit: ' 50' }).error).toBe(AUDIT_LIST_LIMIT_INVALID);
    expect(parseAuditListQuery({ limit: '50 ' }).limit).toBeNull();
    expect(parseAuditListQuery({ limit: '0' }).error).toBe('审计条数需为 1 到 500 的整数');
    expect(parseAuditListQuery({ action }).error).toBe(AUDIT_LIST_ACTION_TOO_LONG);
    expect(AUDIT_LIST_ACTION_TOO_LONG).toBe('审计动作最长 80 字');
    expect(parseAuditListQuery({ target }).error).toBe(AUDIT_LIST_TARGET_TOO_LONG);
    expect(AUDIT_LIST_TARGET_TOO_LONG).toBe('审计对象最长 120 字');
    expect(parseAuditListQuery({ userId }).error).toBe(AUDIT_LIST_USER_ID_TOO_LONG);
    expect(AUDIT_LIST_USER_ID_TOO_LONG).toBe('用户编号最长 36 字');
    expect(parseAuditListQuery({ before: '1'.repeat(20) }).error).toBe('审计游标无效');
    expect(parseAuditListQuery({ before: '1'.repeat(41) }).error).toBe('审计游标无效');
    expect(parseAuditListQuery({ before: '2026-10-26 11:14:02' }).error).toBe('审计游标无效');
    expect(parseAuditListQuery({ before: ' ' }).error).toBe('审计游标无效');
    expect(
      parseAuditListQuery({
        limit: 0,
        action,
        target,
        userId,
        before: 'not-a-cursor',
      }).error,
    ).toBe(AUDIT_LIST_LIMIT_INVALID);
    expect(parseAuditListQuery({ limit: 10, action, target, userId, before: 'not-a-cursor' }).error).toBe(
      AUDIT_LIST_ACTION_TOO_LONG,
    );
    expect(parseAuditListQuery({ limit: '10', action: 'ok', target, userId, before: 'not-a-cursor' }).error).toBe(
      AUDIT_LIST_TARGET_TOO_LONG,
    );
    expect(parseAuditListQuery({ action: 'ok', target: 'row', userId, before: 'not-a-cursor' }).error).toBe(
      AUDIT_LIST_USER_ID_TOO_LONG,
    );
    expect(parseAuditListQuery({ action: 'ok', target: 'row', userId: 'user-1', before: 'not-a-cursor' }).error).toBe(
      '审计游标无效',
    );
  });

  it('数组', () => {
    expect(parseAuditListQuery({ limit: ['50'] })).toEqual({
      error: AUDIT_LIST_LIMIT_INVALID,
      limit: null,
      action: null,
      target: null,
      userId: null,
      beforeId: null,
    });
    expect(parseAuditListQuery({ limit: [] }).error).toBe(AUDIT_LIST_LIMIT_INVALID);
    expect(parseAuditListQuery({ limit: 1.5, action: ['task.create'] }).error).toBe(AUDIT_LIST_LIMIT_INVALID);
    expect(parseAuditListQuery({ action: ['task.create'] }).error).toBe(AUDIT_LIST_ACTION_TOO_LONG);
    expect(parseAuditListQuery({ action: [] }).error).toBe(AUDIT_LIST_ACTION_TOO_LONG);
    expect(parseAuditListQuery({ action: 1 }).error).toBe(AUDIT_LIST_ACTION_TOO_LONG);
    expect(parseAuditListQuery({ action: true }).error).toBe(AUDIT_LIST_ACTION_TOO_LONG);
    expect(parseAuditListQuery({ target: ['row'] }).error).toBe(AUDIT_LIST_TARGET_TOO_LONG);
    expect(parseAuditListQuery({ target: { id: 'row' } }).error).toBe(AUDIT_LIST_TARGET_TOO_LONG);
    expect(parseAuditListQuery({ userId: ['user-1'] }).error).toBe(AUDIT_LIST_USER_ID_TOO_LONG);
    expect(parseAuditListQuery({ userId: 36 }).error).toBe(AUDIT_LIST_USER_ID_TOO_LONG);
    expect(parseAuditListQuery({ before: ['42'] }).error).toBe('审计游标无效');
    expect(parseAuditListQuery({ before: [] }).error).toBe('审计游标无效');
    expect(parseAuditListQuery({ before: 42 }).error).toBe('审计游标无效');
    expect(
      parseAuditListQuery({
        action: ['task.create'],
        target: ['row'],
        userId: ['user-1'],
        before: ['42'],
      }).error,
    ).toBe(AUDIT_LIST_ACTION_TOO_LONG);
    expect(parseAuditListQuery({ target: ['row'], userId: ['user-1'], before: ['42'] }).error).toBe(
      AUDIT_LIST_TARGET_TOO_LONG,
    );
    expect(parseAuditListQuery({ userId: ['user-1'], before: ['42'] }).error).toBe(AUDIT_LIST_USER_ID_TOO_LONG);
  });
});
