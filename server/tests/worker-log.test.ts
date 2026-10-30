import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { storedTraceId, workerTaskFields } from '../src/lib/worker-log.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('worker task log fields', () => {
  it('keeps a short request id and drops blank or control characters', () => {
    expect(storedTraceId('  abc-123  ')).toBe('abc-123');
    expect(storedTraceId('')).toBeNull();
    expect(storedTraceId(undefined)).toBeNull();
    expect(storedTraceId('bad\nid')).toBeNull();
    expect(storedTraceId('x'.repeat(80))).toHaveLength(64);
  });

  it('copies task, user and trace ids only', () => {
    expect(workerTaskFields({
      id: 'task-1',
      user_id: 'user-1',
      trace_id: 'trace-1',
      prompt: 'secret prompt',
      email: 'alice@example.com',
    })).toEqual({ taskId: 'task-1', userId: 'user-1', traceId: 'trace-1' });
  });

  it('omits a blank trace id', () => {
    expect(workerTaskFields({ id: 'task-1', user_id: 'user-1', trace_id: '  ' })).toEqual({
      taskId: 'task-1',
      userId: 'user-1',
    });
  });

  it('adds a nullable trace_id column without touching foreign keys', () => {
    const root = join(here, '../src/db');
    const migration = readFileSync(join(root, 'migrations/0012_task_trace_id.sql'), 'utf8').replace(/--.*$/gm, '');
    const schema = readFileSync(join(root, 'schema.sql'), 'utf8');
    expect(migration).toContain('trace_id VARCHAR(64) NULL');
    expect(migration).toMatch(/information_schema\.COLUMNS/);
    expect(migration).not.toMatch(/\b(DROP|DELETE|PARTITION)\b/i);
    expect(schema).toContain('trace_id     VARCHAR(64)  NULL');
  });
});