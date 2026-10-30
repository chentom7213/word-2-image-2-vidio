import { describe, expect, it } from 'vitest';
import { auditBeforeId } from '../src/services/audit-page.js';

describe('audit page cursor', () => {
  it('treats the cursor as an audit id', () => {
    expect(auditBeforeId(undefined)).toBeNull();
    expect(auditBeforeId('42')).toEqual({ id: '42' });
    expect(auditBeforeId('2026-10-26 11:14:02')).toEqual({ error: '审计游标无效' });
    expect(auditBeforeId('0')).toEqual({ error: '审计游标无效' });
  });
});
