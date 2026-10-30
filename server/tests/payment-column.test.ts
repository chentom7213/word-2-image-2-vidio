import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { storedPaymentEventId, storedPaymentPayload, storedPaymentTxnId } from '../src/lib/payment-column.js';

function eventHash(eventId: string): string {
  return `h:${createHash('sha256').update(eventId).digest('hex')}`;
}

describe('storedPaymentEventId', () => {
  it('刚好 120', () => {
    const eventId = ` ${'e'.repeat(119)}`;
    expect(eventId).toHaveLength(120);
    expect(storedPaymentEventId(eventId)).toBe(eventId);
  });

  it('超过 120 时相同原文得到同一个 h: 值', () => {
    const eventId = ` ${'e'.repeat(120)}`;
    expect(eventId.length).toBeGreaterThan(120);
    const first = storedPaymentEventId(eventId);
    const second = storedPaymentEventId(eventId);
    expect(first).toBe(second);
    expect(first).toBe(eventHash(eventId));
    expect(first).toHaveLength(66);
    expect(first.startsWith('h:')).toBe(true);
  });

  it('不同长原文得到不同值', () => {
    const left = 'e'.repeat(121);
    const right = `${'e'.repeat(121)}x`;
    const leftStored = storedPaymentEventId(left);
    const rightStored = storedPaymentEventId(right);
    expect(leftStored).not.toBe(rightStored);
    expect(leftStored).toBe(eventHash(left));
    expect(rightStored).toBe(eventHash(right));
  });

  it('短号不被改写', () => {
    expect(storedPaymentEventId('evt-1')).toBe('evt-1');
    expect(storedPaymentEventId(' evt-1 ')).toBe(' evt-1 ');
    expect(storedPaymentEventId('')).toBe('');
    expect(storedPaymentEventId('e'.repeat(119))).toBe('e'.repeat(119));
  });
});

describe('storedPaymentTxnId', () => {
  it('刚好 120', () => {
    const txnId = ` ${'t'.repeat(119)}`;
    expect(txnId).toHaveLength(120);
    expect(storedPaymentTxnId(txnId)).toBe(txnId);
  });

  it('超过 120 变成 null', () => {
    expect(storedPaymentTxnId('t'.repeat(121))).toBeNull();
    expect(storedPaymentTxnId(` ${'t'.repeat(120)}`)).toBeNull();
  });

  it('空字符串变成 null', () => {
    expect(storedPaymentTxnId('')).toBeNull();
    expect(storedPaymentTxnId(null)).toBeNull();
    expect(storedPaymentTxnId(undefined)).toBeNull();
  });
});

describe('storedPaymentPayload', () => {
  it('短 payload 原样', () => {
    const payload = { event: 'paid', note: '  keep  ', amount: 100 };
    expect(storedPaymentPayload(payload)).toBe(JSON.stringify(payload));
    const exact = 'a'.repeat(59_998);
    const exactText = JSON.stringify(exact);
    expect(exactText).toHaveLength(60_000);
    expect(storedPaymentPayload(exact)).toBe(exactText);
  });

  it('超长 payload 是合法 JSON 且 omitted 为 true', () => {
    const text = storedPaymentPayload('a'.repeat(60_000));
    expect(text).toBe('{"omitted":true}');
    expect(JSON.parse(String(text))).toEqual({ omitted: true });
  });

  it('stringify 抛错时返回 null', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(storedPaymentPayload(circular)).toBeNull();
    expect(storedPaymentPayload(1n)).toBeNull();
  });
});
