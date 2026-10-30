import { describe, expect, it } from 'vitest';
import { displayNameFromEmail, emailSchema, personalOrgName } from '../src/lib/email-length.js';

const DOMAIN = '@example.com';
const ORG_SUFFIX = ' 的工作空间';

function emailOfLength(length: number): string {
  return `${'a'.repeat(length - DOMAIN.length)}${DOMAIN}`;
}

function issueMessage(value: string): string | undefined {
  const parsed = emailSchema.safeParse(value);
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

describe('emailSchema', () => {
  it('格式不对', () => {
    expect(issueMessage('not-an-email')).toBe('邮箱格式不正确');
  });

  it('很长但格式不对', () => {
    expect(issueMessage('x'.repeat(300))).toBe('邮箱格式不正确');
  });

  it('超过 190 的合法邮箱', () => {
    const email = emailOfLength(191);
    expect(email).toHaveLength(191);
    expect(issueMessage(email)).toBe('邮箱最长 190 字');
  });

  it('刚好 190', () => {
    const email = emailOfLength(190);
    expect(email).toHaveLength(190);
    const parsed = emailSchema.safeParse(`  ${email.toUpperCase()}  `);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe(email);
  });
});

describe('displayNameFromEmail', () => {
  it('短显示名', () => {
    expect(displayNameFromEmail('ada@example.com')).toBe('ada');
  });

  it('超长显示名截到 80', () => {
    const local = 'n'.repeat(81);
    expect(displayNameFromEmail(`${local}@example.com`)).toBe('n'.repeat(80));
    expect(displayNameFromEmail(`${local}@example.com`)).toHaveLength(80);
  });
});

describe('personalOrgName', () => {
  it('短组织名不变', () => {
    expect(personalOrgName('ada@example.com')).toBe(`ada${ORG_SUFFIX}`);
  });

  it('超长组织名仍以「 的工作空间」结尾且不超过 120', () => {
    const local = 'a'.repeat(200);
    const name = personalOrgName(`${local}@example.com`);
    expect(name.endsWith(ORG_SUFFIX)).toBe(true);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name).toBe(`${local.slice(0, 120 - ORG_SUFFIX.length)}${ORG_SUFFIX}`);
  });
});
