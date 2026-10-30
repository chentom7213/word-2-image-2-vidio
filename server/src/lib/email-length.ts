import { z } from 'zod';

export const EMAIL_MAX_LENGTH = 190;
export const DISPLAY_NAME_MAX_LENGTH = 80;
export const ORG_NAME_MAX_LENGTH = 120;

export const EMAIL_INVALID = '邮箱格式不正确';
export const EMAIL_TOO_LONG = '邮箱最长 190 字';

const PERSONAL_ORG_SUFFIX = ' 的工作空间';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email(EMAIL_INVALID)
  .max(EMAIL_MAX_LENGTH, EMAIL_TOO_LONG);

/** 取 @ 前面的部分，按原文字符截到 80。短名字保持原样。 */
export function displayNameFromEmail(email: string): string {
  return email.split('@')[0].slice(0, DISPLAY_NAME_MAX_LENGTH);
}

/** 本地部分 +「 的工作空间」。整句最长 120 字，超长时只截短本地部分。 */
export function personalOrgName(email: string): string {
  const local = email.split('@')[0];
  const maxLocal = ORG_NAME_MAX_LENGTH - PERSONAL_ORG_SUFFIX.length;
  return `${local.slice(0, maxLocal)}${PERSONAL_ORG_SUFFIX}`;
}
