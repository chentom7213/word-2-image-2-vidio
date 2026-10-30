import { beforeEach, describe, expect, it, vi } from 'vitest';

const queries: Array<{ sql: string; params: unknown[] }> = [];
let failWrite = false;

vi.mock('../src/db/pool.js', () => ({
  query: async (sql: string, params: unknown[] = []) => {
    if (failWrite) throw new Error('db down');
    queries.push({ sql, params });
    return [];
  },
}));

import { auditField } from '../src/lib/audit-field.js';
import { audit } from '../src/services/audit.js';

function inserted(): unknown[] {
  const row = queries.find((item) => item.sql.includes('INSERT INTO audit_logs'));
  if (!row) throw new Error('audit row was not inserted');
  return row.params;
}

describe('auditField', () => {
  it('null', () => {
    expect(auditField(null, 120)).toBeNull();
    expect(auditField(undefined, 80)).toBeNull();
  });

  it('空白保留', () => {
    expect(auditField('  目标  ', 120)).toBe('  目标  ');
    expect(auditField('', 45)).toBe('');
    expect(auditField(' '.repeat(130), 120)).toBe(' '.repeat(120));
  });

  it('刚好 120', () => {
    const value = ` ${'标'.repeat(118)} `;
    expect(value).toHaveLength(120);
    expect(auditField(value, 120)).toBe(value);
  });
});

describe('audit', () => {
  beforeEach(() => {
    queries.length = 0;
    failWrite = false;
  });

  it('target 超过 120', async () => {
    const target = `  ${'标'.repeat(130)}`;
    const userId = 'u'.repeat(200);
    const orgId = 'o'.repeat(200);
    await audit({ action: 'demo', target, userId, orgId });
    const params = inserted();
    expect(queries).toHaveLength(1);
    expect(params[3]).toBe(target.slice(0, 120));
    expect(params[3]).toHaveLength(120);
    expect(String(params[3]).startsWith('  ')).toBe(true);
    expect(params[0]).toBe(orgId);
    expect(params[1]).toBe(userId);
  });

  it('刚好 120', async () => {
    const target = '标'.repeat(120);
    await audit({ action: 'demo', target, ip: '127.0.0.1' });
    const params = inserted();
    expect(params[2]).toBe('demo');
    expect(params[3]).toBe(target);
    expect(params[4]).toBe('127.0.0.1');
  });

  it('空白保留', async () => {
    await audit({ action: '  act  ', target: '', ip: '  ', ua: '  ua  ' });
    const params = inserted();
    expect(params[2]).toBe('  act  ');
    expect(params[3]).toBe('');
    expect(params[4]).toBe('  ');
    expect(params[5]).toBe('  ua  ');
  });

  it('null', async () => {
    await audit({ action: 'demo', target: null, ip: null, ua: null, userId: null, orgId: undefined });
    const params = inserted();
    expect(params[0]).toBeNull();
    expect(params[1]).toBeNull();
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
    expect(params[5]).toBeNull();
  });

  it('action 超过 80', async () => {
    const action = ` ${'动'.repeat(90)}`;
    await audit({ action });
    const params = inserted();
    expect(queries).toHaveLength(1);
    expect(params[2]).toBe(action.slice(0, 80));
    expect(params[2]).toHaveLength(80);
  });

  it('ip 超过 45', async () => {
    const ip = ` ${'1'.repeat(50)}`;
    await audit({ action: 'demo', ip });
    const params = inserted();
    expect(queries).toHaveLength(1);
    expect(params[4]).toBe(ip.slice(0, 45));
    expect(params[4]).toHaveLength(45);
  });

  it('ua 超过 300', async () => {
    const ua = 'U'.repeat(301);
    await audit({ action: 'demo', ua });
    expect(inserted()[5]).toBe('U'.repeat(300));
  });

  it('写入失败仍然不抛出', async () => {
    failWrite = true;
    await expect(audit({ action: '动'.repeat(100), target: '标'.repeat(200) })).resolves.toBeUndefined();
    expect(queries).toHaveLength(0);
  });
});
