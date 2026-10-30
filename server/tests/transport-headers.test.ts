import { describe, expect, it } from 'vitest';
import { transportHeaders } from '../src/lib/transport-headers.js';

describe('transport headers', () => {
  it('adds HSTS only when the client connection is HTTPS', () => {
    expect(transportHeaders('https')['Strict-Transport-Security']).toBe('max-age=31536000');
    expect(transportHeaders('http')['Strict-Transport-Security']).toBeUndefined();
  });

  it('always blocks framing and content sniffing', () => {
    for (const protocol of ['http', 'https']) {
      expect(transportHeaders(protocol)).toMatchObject({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      });
    }
  });
});
