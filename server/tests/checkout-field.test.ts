import { describe, expect, it } from 'vitest';
import { checkoutFieldProblem, shouldReleaseCheckoutIdempotency } from '../src/lib/checkout-field.js';

const ORDER_TOO_LONG = '支付单号最长 120 字';
const URL_TOO_LONG = '支付链接最长 2048 字';

describe('checkoutFieldProblem', () => {
  it('单号超过 120', () => {
    expect(checkoutFieldProblem('o'.repeat(121), 'https://pay.example/ok')).toBe(ORDER_TOO_LONG);
    expect(checkoutFieldProblem(` ${'o'.repeat(120)}`, 'https://pay.example/ok')).toBe(ORDER_TOO_LONG);
  });

  it('单号刚好 120', () => {
    expect(checkoutFieldProblem('o'.repeat(120), 'https://pay.example/ok')).toBeNull();
    expect(checkoutFieldProblem(' '.repeat(120), 'https://pay.example/ok')).toBeNull();
  });

  it('链接超过 2048', () => {
    expect(checkoutFieldProblem('order-1', 'u'.repeat(2049))).toBe(URL_TOO_LONG);
    expect(checkoutFieldProblem('order-1', ` ${'u'.repeat(2048)}`)).toBe(URL_TOO_LONG);
  });

  it('链接刚好 2048', () => {
    expect(checkoutFieldProblem('order-1', 'u'.repeat(2048))).toBeNull();
    expect(checkoutFieldProblem('order-1', ' '.repeat(2048))).toBeNull();
  });

  it('两个都超长时先报单号', () => {
    expect(checkoutFieldProblem('o'.repeat(121), 'u'.repeat(2049))).toBe(ORDER_TOO_LONG);
  });

  it('两个都合法', () => {
    expect(checkoutFieldProblem('order-1', 'https://pay.example/ok')).toBeNull();
    expect(checkoutFieldProblem('o'.repeat(120), 'u'.repeat(2048))).toBeNull();
  });

  it('空字符串', () => {
    expect(checkoutFieldProblem('', '')).toBeNull();
    expect(checkoutFieldProblem('', 'https://pay.example/ok')).toBeNull();
    expect(checkoutFieldProblem('order-1', '')).toBeNull();
  });
});

describe('shouldReleaseCheckoutIdempotency', () => {
  const pendingEmpty = {
    status: 'pending',
    providerOrderId: null,
    payUrl: null,
  };

  it('网关抛错且单号链接都空时放开', () => {
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: true,
        fieldProblem: null,
        ...pendingEmpty,
      }),
    ).toBe(true);
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: true,
        fieldProblem: null,
        status: 'pending',
        providerOrderId: undefined,
        payUrl: undefined,
      }),
    ).toBe(true);
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: true,
        fieldProblem: null,
        status: 'pending',
        providerOrderId: '',
        payUrl: '',
      }),
    ).toBe(true);
  });

  it('字段校验返回文案且单号链接都空时放开', () => {
    const orderProblem = checkoutFieldProblem('o'.repeat(121), 'https://pay.example/ok');
    const urlProblem = checkoutFieldProblem('order-1', 'u'.repeat(2049));
    expect(orderProblem).toBe(ORDER_TOO_LONG);
    expect(urlProblem).toBe(URL_TOO_LONG);
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: false,
        fieldProblem: orderProblem,
        ...pendingEmpty,
      }),
    ).toBe(true);
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: false,
        fieldProblem: urlProblem,
        ...pendingEmpty,
      }),
    ).toBe(true);
  });

  it('没有失败时不放开', () => {
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: false,
        fieldProblem: null,
        ...pendingEmpty,
      }),
    ).toBe(false);
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: false,
        fieldProblem: '',
        ...pendingEmpty,
      }),
    ).toBe(false);
  });

  it('已经写下单号或链接时不放开', () => {
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: true,
        fieldProblem: ORDER_TOO_LONG,
        status: 'pending',
        providerOrderId: 'order-1',
        payUrl: 'https://pay.example/ok',
      }),
    ).toBe(false);
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: true,
        fieldProblem: null,
        status: 'pending',
        providerOrderId: 'order-1',
        payUrl: null,
      }),
    ).toBe(false);
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: true,
        fieldProblem: null,
        status: 'pending',
        providerOrderId: null,
        payUrl: 'https://pay.example/ok',
      }),
    ).toBe(false);
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: true,
        fieldProblem: null,
        status: 'pending',
        providerOrderId: ' ',
        payUrl: '',
      }),
    ).toBe(false);
  });

  it('不是 pending 时不放开', () => {
    for (const status of ['paid', 'failed', 'refunded', 'expired']) {
      expect(
        shouldReleaseCheckoutIdempotency({
          gatewayFailed: true,
          fieldProblem: URL_TOO_LONG,
          status,
          providerOrderId: null,
          payUrl: null,
        }),
      ).toBe(false);
    }
  });

  it('写入失败且单号链接都空时放开', () => {
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: false,
        fieldProblem: null,
        writeFailed: true,
        ...pendingEmpty,
      }),
    ).toBe(true);
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: false,
        fieldProblem: null,
        writeFailed: true,
        status: 'pending',
        providerOrderId: undefined,
        payUrl: undefined,
      }),
    ).toBe(true);
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: false,
        fieldProblem: null,
        writeFailed: true,
        status: 'pending',
        providerOrderId: '',
        payUrl: '',
      }),
    ).toBe(true);
  });

  it('写入失败但已有单号或链接时不放开', () => {
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: false,
        fieldProblem: null,
        writeFailed: true,
        status: 'pending',
        providerOrderId: 'order-1',
        payUrl: null,
      }),
    ).toBe(false);
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: false,
        fieldProblem: null,
        writeFailed: true,
        status: 'pending',
        providerOrderId: null,
        payUrl: 'https://pay.example/ok',
      }),
    ).toBe(false);
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: false,
        fieldProblem: null,
        writeFailed: true,
        status: 'pending',
        providerOrderId: ' ',
        payUrl: '',
      }),
    ).toBe(false);
  });

  it('写入失败但不是 pending 时不放开', () => {
    for (const status of ['paid', 'failed', 'refunded', 'expired']) {
      expect(
        shouldReleaseCheckoutIdempotency({
          gatewayFailed: false,
          fieldProblem: null,
          writeFailed: true,
          status,
          providerOrderId: null,
          payUrl: null,
        }),
      ).toBe(false);
    }
  });

  it('三个原因都是 false 或缺省时不放开', () => {
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: false,
        fieldProblem: null,
        writeFailed: false,
        ...pendingEmpty,
      }),
    ).toBe(false);
    expect(
      shouldReleaseCheckoutIdempotency({
        gatewayFailed: false,
        fieldProblem: null,
        ...pendingEmpty,
      }),
    ).toBe(false);
  });
});
