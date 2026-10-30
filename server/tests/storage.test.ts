import { describe, expect, it } from 'vitest';
import { resolveWithinRoot } from '../src/services/storage/local.js';

/**
 * Path traversal is the classic object-store foot-gun: a key like
 * `../../etc/passwd` must never resolve outside the storage root.
 * `resolveWithinRoot` is the single choke point both drivers rely on.
 */
describe('resolveWithinRoot', () => {
  it('resolves a normal object key inside the root', () => {
    const p = resolveWithinRoot('outputs/u1/2026/01/t1/0-image.png');
    expect(p).toMatch(/outputs[\\/]u1[\\/]2026[\\/]01[\\/]t1[\\/]0-image\.png$/);
  });

  it('strips leading slashes so a key can never become an absolute path', () => {
    const p = resolveWithinRoot('/uploads/u1/a.png');
    expect(p).not.toMatch(/^[\\/]uploads/);
    expect(p).toMatch(/uploads[\\/]u1[\\/]a\.png$/);
  });

  it('rejects ../ traversal', () => {
    expect(() => resolveWithinRoot('../../../etc/passwd')).toThrow(/非法对象路径/);
    expect(() => resolveWithinRoot('uploads/../../secret.txt')).toThrow(/非法对象路径/);
  });

  it('treats percent-encoding literally — decoding happens in the route', () => {
    // `resolveWithinRoot` never decodes, so `%2e%2e` is a literal (harmless)
    // name. This pins the contract: any route that URI-decodes a key MUST pass
    // the decoded value here, which /media/* does.
    expect(() => resolveWithinRoot('uploads/%2e%2e/%2e%2e/secret')).not.toThrow();
  });

  it('rejects traversal after the route decodes a double-encoded key', () => {
    const decoded = decodeURIComponent('uploads/%2e%2e/%2e%2e/secret');
    expect(decoded).toContain('..');
    expect(() => resolveWithinRoot(decoded)).toThrow(/非法对象路径/);
  });

  it('allows a key that merely contains dots', () => {
    expect(() => resolveWithinRoot('uploads/u1/archive.tar.gz')).not.toThrow();
    expect(() => resolveWithinRoot('outputs/u1/..hidden/file.png')).not.toThrow();
  });
});
