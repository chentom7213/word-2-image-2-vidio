import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  missingNextAttemptColumn,
  nextAttemptAt,
  queuedReadySql,
  retryDelayMs,
} from '../src/services/retry-schedule.js';

describe('retry schedule', () => {
  it('backs off by powers of two and stops at 30 seconds', () => {
    expect(retryDelayMs(1)).toBe(2_000);
    expect(retryDelayMs(2)).toBe(4_000);
    expect(retryDelayMs(10)).toBe(30_000);
  });

  it('stores a UTC timestamp that far ahead and hides rows until then', () => {
    const now = Date.UTC(2026, 9, 26, 11, 14, 0, 0);
    expect(nextAttemptAt(1, now)).toBe('2026-10-26 11:14:02.000');
    expect(queuedReadySql()).toContain('next_attempt_at <= UTC_TIMESTAMP(3)');
  });

  it('treats a missing column as absent and keeps the migration off foreign keys', () => {
    expect(missingNextAttemptColumn({ code: 'ER_BAD_FIELD_ERROR' })).toBe(true);
    expect(missingNextAttemptColumn(new Error('Unknown column next_attempt_at'))).toBe(true);
    expect(missingNextAttemptColumn(new Error('deadlock'))).toBe(false);
    const migration = readFileSync(new URL('../src/db/migrations/0016_task_next_attempt_at.sql', import.meta.url), 'utf8');
    const schema = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
    expect(migration).toContain('next_attempt_at');
    expect(migration).not.toContain('FOREIGN KEY');
    expect(migration).not.toContain('PARTITION');
    expect(schema).toContain('next_attempt_at DATETIME(3) NULL');
  });
});
