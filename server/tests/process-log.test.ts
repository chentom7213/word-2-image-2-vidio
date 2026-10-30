import { describe, expect, it } from 'vitest';
import { formatProcessLog, jsonLogsEnabled, oneLineDetail } from '../src/lib/process-log.js';

describe('process logs', () => {
  it('follows the API JSON switch', () => {
    expect(jsonLogsEnabled({ NODE_ENV: 'production' })).toBe(true);
    expect(jsonLogsEnabled({ LOG_JSON: 'true' })).toBe(true);
    expect(jsonLogsEnabled({ NODE_ENV: 'development', LOG_JSON: 'false' })).toBe(false);
    expect(jsonLogsEnabled({})).toBe(false);
  });

  it('keeps the readable line outside production', () => {
    expect(formatProcessLog({ msg: 'worker ready' }, false, '[worker] 就绪，等待任务…')).toBe(
      '[worker] 就绪，等待任务…',
    );
  });

  it('writes one JSON object and drops secrets and line breaks', () => {
    const line = formatProcessLog(
      {
        msg: 'worker redis read failed',
        error: 'down\npassword=secret',
        email: 'alice@example.com',
        prompt: 'secret prompt',
        count: 2,
      },
      true,
      'ignored',
    );
    expect(line).not.toContain('\n');
    expect(line).not.toContain('alice@example.com');
    expect(line).not.toContain('secret prompt');
    expect(JSON.parse(line)).toEqual({
      msg: 'worker redis read failed',
      error: 'down password=secret',
      count: 2,
    });
  });

  it('shortens an error message', () => {
    expect(oneLineDetail(new Error(`x${'y'.repeat(400)}`))).toHaveLength(300);
  });
});