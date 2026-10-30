import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkoutReplayPayUrl, missingPayUrlColumn } from '../src/services/payments.js';

const base = 'http://127.0.0.1:8787';

describe('checkout replay pay url', () => {
  it('returns the stored gateway link for a pending order', () => {
    expect(
      checkoutReplayPayUrl(
        { id: 'order-1', status: 'pending', provider: 'stripe', pay_url: ' https://pay.example/s ' },
        base,
      ),
    ).toBe('https://pay.example/s');
  });

  it('rebuilds only the mock link when no stored url exists', () => {
    expect(
      checkoutReplayPayUrl({ id: 'order-1', status: 'pending', provider: 'mock', pay_url: null }, base),
    ).toBe('http://127.0.0.1:8787/api/billing/mock/pay?order=order-1');
    expect(
      checkoutReplayPayUrl({ id: 'order-1', status: 'pending', provider: 'wechat', pay_url: null }, base),
    ).toBeNull();
  });

  it('does not offer a link after the order leaves pending', () => {
    expect(
      checkoutReplayPayUrl(
        { id: 'order-1', status: 'paid', provider: 'mock', pay_url: 'https://pay.example/s' },
        base,
      ),
    ).toBeNull();
  });

  it('treats a missing pay_url column as absent and keeps the column off foreign keys', () => {
    expect(missingPayUrlColumn({ code: 'ER_BAD_FIELD_ERROR' })).toBe(true);
    expect(missingPayUrlColumn(new Error('Unknown column pay_url'))).toBe(true);
    expect(missingPayUrlColumn(new Error('deadlock'))).toBe(false);
    const migration = readFileSync(new URL('../src/db/migrations/0015_order_pay_url.sql', import.meta.url), 'utf8');
    const schema = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
    expect(migration).toContain('pay_url');
    expect(migration).not.toContain('FOREIGN KEY');
    expect(migration).not.toContain('PARTITION');
    expect(schema).toContain('pay_url          VARCHAR(2048) NULL');
  });
});
