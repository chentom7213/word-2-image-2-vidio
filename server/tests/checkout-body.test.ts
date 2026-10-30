import { describe, expect, it } from 'vitest';
import { checkoutBodyMessage } from '../src/lib/checkout-body.js';

describe('checkoutBodyMessage', () => {
  it('kind 返回下单种类无效', () => {
    expect(checkoutBodyMessage('kind')).toBe('下单种类无效');
  });

  it('skuId 返回套餐编号无效', () => {
    expect(checkoutBodyMessage('skuId')).toBe('套餐编号无效');
  });

  it('undefined 和其他字段返回 null', () => {
    expect(checkoutBodyMessage(undefined)).toBeNull();
    expect(checkoutBodyMessage('amount')).toBeNull();
    expect(checkoutBodyMessage('sku_id')).toBeNull();
    expect(checkoutBodyMessage(0)).toBeNull();
    expect(checkoutBodyMessage(Symbol('kind'))).toBeNull();
  });
});
