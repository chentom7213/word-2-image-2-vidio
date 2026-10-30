import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/lib/redact-url.js';

describe('access log url redaction', () => {
  it('hides tokens, signatures, and enterprise login callback values', () => {
    const raw =
      '/api/auth/oidc/callback?code=secret-code&state=secret-state&token=jwt&access_token=a&s=sig&e=1&next=/video';
    const cleaned = redactUrl(raw);
    expect(cleaned).toContain('next=/video');
    expect(cleaned).not.toContain('secret-code');
    expect(cleaned).not.toContain('secret-state');
    expect(cleaned).not.toContain('jwt');
    expect(cleaned).toContain('code=***');
    expect(cleaned).toContain('state=***');
    expect(cleaned).toContain('token=***');
    expect(cleaned).toContain('s=***');
  });

  it('leaves a url without a query unchanged', () => {
    expect(redactUrl('/api/health')).toBe('/api/health');
    expect(redactUrl('/api/models?kind=video')).toBe('/api/models?kind=video');
  });
});
