import { describe, expect, it } from 'vitest';
import { apiKeyNameSchema, inviteEmailSchema, orgNameSchema } from '../src/lib/team-field.js';

describe('orgNameSchema', () => {
  it('空白组织名', () => {
    const parsed = orgNameSchema.safeParse('   ');
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toBe('请填写组织名称');
  });

  it('超过 120', () => {
    const parsed = orgNameSchema.safeParse('组'.repeat(121));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toBe('组织名称最长 120 字');
  });

  it('刚好 120', () => {
    const name = '组'.repeat(120);
    const parsed = orgNameSchema.safeParse(name);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe(name);
  });
});

describe('inviteEmailSchema', () => {
  it('不是邮箱', () => {
    const parsed = inviteEmailSchema.safeParse('not-an-email');
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toBe('邮箱格式不正确');
  });

  it('带空格的大写邮箱会变成小写', () => {
    const parsed = inviteEmailSchema.safeParse('  User@Example.COM  ');
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe('user@example.com');
  });
});

describe('apiKeyNameSchema', () => {
  it('空白钥匙名', () => {
    const parsed = apiKeyNameSchema.safeParse('   ');
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toBe('请填写钥匙名称');
  });

  it('超过 80', () => {
    const parsed = apiKeyNameSchema.safeParse('钥'.repeat(81));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toBe('钥匙名称最长 80 字');
  });

  it('刚好 80', () => {
    const name = '钥'.repeat(80);
    const parsed = apiKeyNameSchema.safeParse(name);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe(name);
  });
});
