export const PASSWORD_MAX_LENGTH = 72;

export const PASSWORD_TOO_LONG = '密码最长 72 位';

/** 按原文字符计，不 trim。超过上限才拒绝；空串和刚好到上限都放行。 */
export function passwordTooLongMessage(password: string): string | null {
  if (password.length > PASSWORD_MAX_LENGTH) return PASSWORD_TOO_LONG;
  return null;
}
