import { createHash } from 'node:crypto';

const PAYMENT_ID_MAX_LENGTH = 120;
const PAYMENT_PAYLOAD_MAX_LENGTH = 60_000;
const OMITTED_PAYLOAD = '{"omitted":true}';

/** 按原文。不超过 120 字原样返回；更长时返回 h: 加该原文的 sha256 十六进制，共 66 字。不 trim、不截断。空串原样返回。 */
export function storedPaymentEventId(eventId: string): string {
  if (eventId.length <= PAYMENT_ID_MAX_LENGTH) return eventId;
  return `h:${createHash('sha256').update(eventId).digest('hex')}`;
}

/** null、undefined 和空字符串返回 null。按原文不超过 120 字原样返回；更长时返回 null。不 trim、不截断。 */
export function storedPaymentTxnId(txnId: string | null | undefined): string | null {
  if (txnId == null || txnId === '') return null;
  if (txnId.length <= PAYMENT_ID_MAX_LENGTH) return txnId;
  return null;
}

/** JSON.stringify 后不超过 60000 字返回该字符串；更长时返回 {"omitted":true}。stringify 抛错时返回 null。 */
export function storedPaymentPayload(payload: unknown): string | null {
  try {
    const text = JSON.stringify(payload);
    if (typeof text !== 'string') return null;
    if (text.length <= PAYMENT_PAYLOAD_MAX_LENGTH) return text;
    return OMITTED_PAYLOAD;
  } catch {
    return null;
  }
}
