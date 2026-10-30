import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import { assertBillingOwner } from '../src/routes/billing.js';

describe('billing owner gate', () => {
  it('lets the organization owner continue', () => {
    expect(() => assertBillingOwner('owner')).not.toThrow();
  });

  it.each(['admin', 'editor', 'viewer', undefined])('rejects %s before an order is created', (role) => {
    expect(() => assertBillingOwner(role)).toThrow(ApiError);
    try {
      assertBillingOwner(role);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(403);
      expect((err as ApiError).message).toBe('权限不足');
    }
  });
});
