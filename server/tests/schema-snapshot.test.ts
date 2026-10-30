import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql'), 'utf8');

describe('schema snapshot', () => {
  it('includes the tables added by later migrations', () => {
    for (const table of ['oidc_identities', 'monthly_credit_grants', 'audit_logs_archive', 'canvas_documents']) {
      expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(schema).toContain('KEY idx_audit_org (org_id, created_at)');
    expect(schema).not.toMatch(/PARTITION BY/i);
  });
});
