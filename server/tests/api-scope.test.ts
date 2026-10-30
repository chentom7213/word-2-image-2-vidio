import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { apiScopeAllows, assertApiScope, scopedGenerationTypes } from '../src/middleware/auth.js';

function request(scopes?: string[]): FastifyRequest {
  return { apiScopes: scopes } as FastifyRequest;
}

describe('API key scopes', () => {
  it('lets a session through and treats star as every scope', () => {
    expect(apiScopeAllows(undefined, ['assets:write'])).toBe(true);
    expect(apiScopeAllows(['*'], ['assets:write'])).toBe(true);
    expect(scopedGenerationTypes(undefined)).toBeNull();
    expect(scopedGenerationTypes(['*'])).toBeNull();
    expect(() => assertApiScope(request(undefined), 'assets:write')).not.toThrow();
  });

  it('allows only the scopes written on the key', () => {
    expect(apiScopeAllows(['assets:read'], ['assets:read', 'assets:write'])).toBe(true);
    expect(apiScopeAllows(['assets:read'], ['assets:write'])).toBe(false);
    expect(scopedGenerationTypes(['generate:image'])).toEqual(['image']);
    expect(() => assertApiScope(request(['generate:image']), 'generate:video')).toThrow(/缺少所需权限/);
  });
});