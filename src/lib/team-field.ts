const ORG_NAME_TOO_LONG = '组织名称最长 120 字';
const MAX_ORG_NAME_LENGTH = 120;
const KEY_NAME_TOO_LONG = '钥匙名称最长 80 字';
const MAX_KEY_NAME_LENGTH = 80;
const INVITE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed organization names longer than 120 characters cannot be submitted. */
export function orgNameTooLongMessage(name: string): string | null {
  return name.trim().length > MAX_ORG_NAME_LENGTH ? ORG_NAME_TOO_LONG : null;
}

/** Trimmed API key names longer than 80 characters cannot be submitted. */
export function keyNameTooLongMessage(name: string): string | null {
  return name.trim().length > MAX_KEY_NAME_LENGTH ? KEY_NAME_TOO_LONG : null;
}

/** Trimmed invite emails must look like an address before a request is sent. */
export function inviteEmailLooksValid(email: string): boolean {
  return INVITE_EMAIL_PATTERN.test(email.trim());
}
