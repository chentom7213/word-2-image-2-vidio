/** True only when the account was created without a user-chosen password. */
export function passwordIsUnset(value: unknown): boolean {
  return value === 0 || value === false || value === '0';
}

export function missingPasswordSetColumn(err: unknown): boolean {
  const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : '';
  const message = err instanceof Error ? err.message : String(err ?? '');
  return code === 'ER_BAD_FIELD_ERROR' || message.includes('password_set');
}

/** The unset update can win only once. A later request must send the current password. */
export function passwordUpdateSql(unset: boolean): string {
  return unset
    ? 'UPDATE users SET password_hash = ?, password_set = 1 WHERE id = ? AND password_set = 0'
    : 'UPDATE users SET password_hash = ? WHERE id = ?';
}
