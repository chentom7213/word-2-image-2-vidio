import { describe, expect, it } from 'vitest';
import { withTenant } from '../src/services/tenant-query.js';

const own = { user_id: 'u1', org_id: 'org-a', visibility: 'private' };
const shared = { user_id: 'u2', org_id: 'org-a', visibility: 'org' };
const otherOrg = { user_id: 'u2', org_id: 'org-b', visibility: 'org' };
const privateOther = { user_id: 'u2', org_id: 'org-a', visibility: 'private' };

describe('withTenant', () => {
  it('reads the caller’s own task and the current org’s shared tasks', () => {
    const tenant = withTenant({ userId: 'u1', orgId: 'org-a' });
    expect(tenant.canReadTask(own)).toBe(true);
    expect(tenant.canReadTask(shared)).toBe(true);
    expect(tenant.canReadTask(otherOrg)).toBe(false);
    expect(tenant.canReadTask(privateOther)).toBe(false);
    expect(tenant.taskReadParams()).toEqual(['u1', 'org-a']);
    expect(tenant.taskReadSql()).toContain('user_id = ?');
    expect(tenant.taskReadSql()).toContain("visibility = 'org'");
  });

  it('does not treat a blank org as a shared workspace', () => {
    const tenant = withTenant({ userId: 'u1', orgId: '   ' });
    expect(tenant.orgId).toBe('');
    expect(tenant.canReadTask({ user_id: 'u2', org_id: '', visibility: 'org' })).toBe(false);
    expect(tenant.canReadTask(own)).toBe(true);
    expect(tenant.assetReadParams()).toEqual(['u1']);
    expect(tenant.assetReadSql().includes('org_id')).toBe(false);
  });

  it('keeps asset reads on the creator, including legacy null org rows', () => {
    const tenant = withTenant({ userId: 'u1', orgId: 'org-a' });
    expect(tenant.assetReadParams()).toEqual(['u1', 'org-a']);
    expect(tenant.assetReadSql()).toContain('user_id = ?');
    expect(tenant.assetReadSql()).toContain('org_id IS NULL');
  });

  it('refuses a missing user', () => {
    expect(() => withTenant({ userId: '' })).toThrow(/userId/);
  });
});
