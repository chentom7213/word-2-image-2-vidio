export const OIDC_SUBJECT_MAX_LENGTH = 255;
export const OIDC_ISSUER_MAX_LENGTH = 500;

export const OIDC_SUBJECT_TOO_LONG = '企业身份标识最长 255 字';
export const OIDC_ISSUER_TOO_LONG = '企业登录地址最长 500 字';

/** 按原文字符计，不 trim、不截断。超过上限才拒绝；刚好到上限放行。subject 超长优先于 issuer。 */
export function oidcIdentityProblem(issuer: string, subject: string): string | null {
  if (subject.length > OIDC_SUBJECT_MAX_LENGTH) return OIDC_SUBJECT_TOO_LONG;
  if (issuer.length > OIDC_ISSUER_MAX_LENGTH) return OIDC_ISSUER_TOO_LONG;
  return null;
}
