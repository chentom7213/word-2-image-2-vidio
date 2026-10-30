import { describe, expect, it } from 'vitest';
import { UTC_SESSION_SQL, applyUtcSession, bindUtcSession } from '../src/db/session-tz.js';

describe('database session time zone', () => {
  it('sets each new connection to UTC before it is used', () => {
    const queries: string[] = [];
    const listeners: Array<(connection: { query: (sql: string) => void }) => void> = [];
    bindUtcSession({
      on(_event, listener) {
        listeners.push(listener);
      },
    });
    expect(listeners).toHaveLength(1);
    listeners[0]({
      query(sql) {
        queries.push(sql);
      },
    });
    expect(queries).toEqual([UTC_SESSION_SQL]);
    expect(UTC_SESSION_SQL).toBe("SET time_zone = '+00:00'");
  });

  it('applies the same statement on a standalone connection', async () => {
    const queries: string[] = [];
    await applyUtcSession({
      query(sql) {
        queries.push(sql);
        return Promise.resolve();
      },
    });
    expect(queries).toEqual([UTC_SESSION_SQL]);
  });
});