const EMAIL_TOO_LONG = '邮箱最长 190 字';
const MAX_EMAIL_LENGTH = 190;

/** Trimmed emails longer than 190 characters cannot be submitted. Does not validate email format. */
export function emailTooLongMessage(email: string): string | null {
  return email.trim().length > MAX_EMAIL_LENGTH ? EMAIL_TOO_LONG : null;
}
