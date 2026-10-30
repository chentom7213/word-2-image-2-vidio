import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keys } from '../src/services/storage.js';

describe('object keys', () => {
  it('uses the UTC month when local time is already the next day', () => {
    const instant = new Date('2026-10-31T16:30:00.000Z');
    expect(keys.output('user-1', 'task-1', '0-image.png', instant)).toBe(
      'outputs/user-1/2026/10/task-1/0-image.png',
    );
    expect(keys.upload('user-1', 'file.png', instant)).toBe('uploads/user-1/2026/10/file.png');
  });
});

describe('migration files shipped with the API image', () => {
  it('includes every file from the baseline through the retry timestamp', () => {
    const files = readdirSync(new URL('../src/db/migrations', import.meta.url))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(files[0]).toBe('0001_baseline.sql');
    expect(files.at(-1)).toBe('0016_task_next_attempt_at.sql');
    expect(files).toHaveLength(16);
  });
});
