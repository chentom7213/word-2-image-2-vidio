import { describe, expect, it } from 'vitest';
import {
  ADMIN_ORDER_LIMIT_DEFAULT,
  ADMIN_ORDER_LIMIT_INVALID,
  ADMIN_ORDER_STATUS_INVALID,
  parseAdminOrderQuery,
} from '../src/lib/admin-order-query.js';

describe('parseAdminOrderQuery', () => {
  it('没传状态和条数', () => {
    expect(parseAdminOrderQuery({})).toEqual({ status: null, limit: 50, error: null });
    expect(parseAdminOrderQuery({ status: undefined, limit: undefined })).toEqual({
      status: null,
      limit: ADMIN_ORDER_LIMIT_DEFAULT,
      error: null,
    });
    expect(parseAdminOrderQuery({ status: null, limit: null })).toEqual({ status: null, limit: 50, error: null });
  });

  it('空状态不过滤', () => {
    expect(parseAdminOrderQuery({ status: '' })).toEqual({ status: null, limit: 50, error: null });
    expect(parseAdminOrderQuery({ status: '', limit: '20' })).toEqual({ status: null, limit: 20, error: null });
  });

  it('五种状态原样', () => {
    for (const status of ['pending', 'paid', 'failed', 'refunded', 'expired'] as const) {
      expect(parseAdminOrderQuery({ status })).toEqual({ status, limit: 50, error: null });
    }
  });

  it('状态无效', () => {
    expect(parseAdminOrderQuery({ status: 'cancelled' })).toEqual({
      status: null,
      limit: 50,
      error: ADMIN_ORDER_STATUS_INVALID,
    });
    expect(ADMIN_ORDER_STATUS_INVALID).toBe('订单状态无效');
    expect(parseAdminOrderQuery({ status: 'PAID' })).toEqual({
      status: null,
      limit: 50,
      error: ADMIN_ORDER_STATUS_INVALID,
    });
    expect(parseAdminOrderQuery({ status: ' paid' })).toEqual({
      status: null,
      limit: 50,
      error: ADMIN_ORDER_STATUS_INVALID,
    });
    expect(parseAdminOrderQuery({ status: 1 })).toEqual({
      status: null,
      limit: 50,
      error: ADMIN_ORDER_STATUS_INVALID,
    });
  });

  it('状态数组', () => {
    expect(parseAdminOrderQuery({ status: ['paid'] })).toEqual({
      status: null,
      limit: 50,
      error: ADMIN_ORDER_STATUS_INVALID,
    });
    expect(parseAdminOrderQuery({ status: ['pending', 'paid'] })).toEqual({
      status: null,
      limit: 50,
      error: ADMIN_ORDER_STATUS_INVALID,
    });
    expect(parseAdminOrderQuery({ status: [] })).toEqual({
      status: null,
      limit: 50,
      error: ADMIN_ORDER_STATUS_INVALID,
    });
  });

  it('条数边界和数字字符串', () => {
    expect(parseAdminOrderQuery({ limit: 1 })).toEqual({ status: null, limit: 1, error: null });
    expect(parseAdminOrderQuery({ limit: 50 })).toEqual({ status: null, limit: 50, error: null });
    expect(parseAdminOrderQuery({ limit: 200 })).toEqual({ status: null, limit: 200, error: null });
    expect(parseAdminOrderQuery({ status: 'paid', limit: '1' })).toEqual({ status: 'paid', limit: 1, error: null });
    expect(parseAdminOrderQuery({ limit: '50' })).toEqual({ status: null, limit: 50, error: null });
    expect(parseAdminOrderQuery({ limit: '200' })).toEqual({ status: null, limit: 200, error: null });
  });

  it('条数小数、超出、非整数', () => {
    const invalid = { status: null, limit: 50, error: ADMIN_ORDER_LIMIT_INVALID };
    expect(ADMIN_ORDER_LIMIT_INVALID).toBe('订单条数需为 1 到 200 的整数');
    expect(parseAdminOrderQuery({ limit: 0 })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: 201 })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: 999 })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: -1 })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: 1.5 })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: 200.5 })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: Number.NaN })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: Number.POSITIVE_INFINITY })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: '0' })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: '201' })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: '1.5' })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: '50.0' })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: '1e2' })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: '' })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: ' 50' })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: 'abc' })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: true })).toEqual(invalid);
    expect(parseAdminOrderQuery({ limit: 201 }).limit).not.toBe(200);
    expect(parseAdminOrderQuery({ limit: 1.5 }).limit).not.toBe(200);
  });

  it('条数数组', () => {
    expect(parseAdminOrderQuery({ limit: [50] })).toEqual({
      status: null,
      limit: 50,
      error: ADMIN_ORDER_LIMIT_INVALID,
    });
    expect(parseAdminOrderQuery({ limit: ['50'] })).toEqual({
      status: null,
      limit: 50,
      error: ADMIN_ORDER_LIMIT_INVALID,
    });
    expect(parseAdminOrderQuery({ limit: [] })).toEqual({
      status: null,
      limit: 50,
      error: ADMIN_ORDER_LIMIT_INVALID,
    });
  });

  it('状态无效优先于条数', () => {
    expect(parseAdminOrderQuery({ status: ['paid'], limit: 1.5 })).toEqual({
      status: null,
      limit: 50,
      error: ADMIN_ORDER_STATUS_INVALID,
    });
    expect(parseAdminOrderQuery({ status: 'nope', limit: 201 })).toEqual({
      status: null,
      limit: 50,
      error: ADMIN_ORDER_STATUS_INVALID,
    });
    expect(parseAdminOrderQuery({ status: 'expired', limit: '0' })).toEqual({
      status: 'expired',
      limit: 50,
      error: ADMIN_ORDER_LIMIT_INVALID,
    });
  });
});
