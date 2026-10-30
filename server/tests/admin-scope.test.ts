import { describe, expect, it } from 'vitest';
import { accessLogFields } from '../src/lib/access-log.js';
import { orgMemberPredicate, orgTaskParams, orgTaskPredicate } from '../src/services/admin-scope.js';

describe('org admin scope', () => {
  it('limits tasks to the org and to legacy rows owned by its members', () => {
    expect(orgTaskPredicate()).toBe(
      '(org_id = ? OR (org_id IS NULL AND user_id IN (SELECT user_id FROM memberships WHERE org_id = ?)))',
    );
    expect(orgTaskParams('org-1')).toEqual(['org-1', 'org-1']);
  });

  it('limits ledger rows to members of that org', () => {
    expect(orgMemberPredicate('user_id')).toBe('user_id IN (SELECT user_id FROM memberships WHERE org_id = ?)');
    expect(orgMemberPredicate('u.id')).toBe('u.id IN (SELECT user_id FROM memberships WHERE org_id = ?)');
  });
});

describe('access log fields', () => {
  it('adds the user id and a generation task id without an email', () => {
    const fields = accessLogFields({
      traceId: 't-1',
      method: 'GET',
      url: '/api/generations/task-1?token=secret',
      status: 200,
      ms: 12,
      userId: 'user-1',
      route: '/api/generations/:id',
      paramId: 'task-1',
    });
    expect(fields.userId).toBe('user-1');
    expect(fields.taskId).toBe('task-1');
    expect(fields).not.toHaveProperty('email');
  });

  it('omits taskId on routes that are not a generation record', () => {
    const fields = accessLogFields({
      traceId: 't-2',
      method: 'GET',
      url: '/api/assets/asset-1',
      status: 200,
      ms: 4,
      userId: 'user-1',
      route: '/api/assets/:id',
      paramId: 'asset-1',
    });
    expect(fields.userId).toBe('user-1');
    expect(fields.taskId).toBeUndefined();
  });

  it('omits userId when the request is anonymous', () => {
    const fields = accessLogFields({
      traceId: 't-3',
      method: 'GET',
      url: '/api/live',
      status: 200,
      ms: 1,
      route: '/api/live',
    });
    expect(fields.userId).toBeUndefined();
    expect(fields.taskId).toBeUndefined();
  });
});
