import { describe, expect, it } from 'vitest';
import { memberRoleMessage } from '../src/lib/member-role.js';

describe('memberRoleMessage', () => {
  it('role 返回角色无效', () => {
    expect(memberRoleMessage('role')).toBe('角色无效');
  });

  it('undefined 和 email 返回 null', () => {
    expect(memberRoleMessage(undefined)).toBeNull();
    expect(memberRoleMessage('email')).toBeNull();
  });
});
