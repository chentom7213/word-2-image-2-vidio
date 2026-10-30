import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { missingPasswordSetColumn, passwordIsUnset, passwordUpdateSql } from '../src/services/password-change.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('first local password', () => {
  it('treats only an explicit unset flag as unset', () => {
    expect(passwordIsUnset(0)).toBe(true);
    expect(passwordIsUnset('0')).toBe(true);
    expect(passwordIsUnset(false)).toBe(true);
    expect(passwordIsUnset(1)).toBe(false);
    expect(passwordIsUnset(undefined)).toBe(false);
    expect(passwordIsUnset(null)).toBe(false);
  });

  it('lets the first write win and keeps later writes on the current-password path', () => {
    expect(passwordUpdateSql(true)).toContain('AND password_set = 0');
    expect(passwordUpdateSql(false)).toBe('UPDATE users SET password_hash = ? WHERE id = ?');
  });

  it('recognizes a database that has not added the column', () => {
    expect(missingPasswordSetColumn({ code: 'ER_BAD_FIELD_ERROR' })).toBe(true);
    expect(missingPasswordSetColumn(new Error("Unknown column 'password_set'"))).toBe(true);
    expect(missingPasswordSetColumn(new Error('deadlock'))).toBe(false);
  });

  it('adds the column without foreign keys or partitioning', () => {
    const migration = readFileSync(join(here, '../src/db/migrations/0014_user_password_set.sql'), 'utf8');
    const schema = readFileSync(join(here, '../src/db/schema.sql'), 'utf8');
    expect(migration).toContain('password_set TINYINT(1) NOT NULL DEFAULT 1');
    expect(migration).not.toContain('FOREIGN KEY');
    expect(migration).not.toContain('PARTITION');
    expect(schema).toContain('password_set        TINYINT(1)   NOT NULL DEFAULT 1');
  });
});