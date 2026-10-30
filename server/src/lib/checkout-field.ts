export const PROVIDER_ORDER_ID_MAX_LENGTH = 120;
export const PAY_URL_MAX_LENGTH = 2048;

export const PROVIDER_ORDER_ID_TOO_LONG = '支付单号最长 120 字';
export const PAY_URL_TOO_LONG = '支付链接最长 2048 字';

/** 按原文字符计，不 trim、不截断。超过上限才拒绝；空串和刚好到上限都放行。支付单号超长优先于支付链接。 */
export function checkoutFieldProblem(providerOrderId: string, payUrl: string): string | null {
  if (providerOrderId.length > PROVIDER_ORDER_ID_MAX_LENGTH) return PROVIDER_ORDER_ID_TOO_LONG;
  if (payUrl.length > PAY_URL_MAX_LENGTH) return PAY_URL_TOO_LONG;
  return null;
}

/** null、undefined 和空串都算还没写下。不 trim，空白字符算已经有值。 */
function checkoutColumnUnset(value: string | null | undefined): boolean {
  return value == null || value === '';
}

/**
 * 网关创建抛错、checkoutFieldProblem 返回文案，或写入支付单号和支付链接失败时，才考虑放开幂等键。
 * 没传 writeFailed 时按 false。
 * 还要订单仍是 pending，且支付单号和支付链接都还空着。已经写下单号或链接则保留键。
 */
export function shouldReleaseCheckoutIdempotency(input: {
  gatewayFailed: boolean;
  fieldProblem: string | null;
  writeFailed?: boolean;
  status: string;
  providerOrderId: string | null | undefined;
  payUrl: string | null | undefined;
}): boolean {
  const rejected = input.gatewayFailed || Boolean(input.fieldProblem) || Boolean(input.writeFailed);
  return (
    rejected &&
    input.status === 'pending' &&
    checkoutColumnUnset(input.providerOrderId) &&
    checkoutColumnUnset(input.payUrl)
  );
}
