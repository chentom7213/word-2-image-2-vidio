const PASSWORD_TOO_LONG = '密码最长 72 位';
const MAX_PASSWORD_LENGTH = 72;

/** Raw passwords longer than 72 characters cannot be submitted. */
export function passwordTooLongMessage(password: string): string | null {
  return password.length > MAX_PASSWORD_LENGTH ? PASSWORD_TOO_LONG : null;
}
