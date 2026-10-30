import { query } from '../db/pool.js';
import { auditField } from '../lib/audit-field.js';

/**
 * Append-only audit trail. Never throws: an audit write must not be able to
 * fail the business operation it is recording.
 */
export type AuditEntry = {
  userId?: string | null;
  orgId?: string | null;
  action: string;
  target?: string | null;
  ip?: string | null;
  ua?: string | null;
  meta?: Record<string, unknown> | null;
};

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      'INSERT INTO audit_logs (org_id, user_id, action, target, ip, ua, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        entry.orgId ?? null,
        entry.userId ?? null,
        auditField(entry.action, 80),
        auditField(entry.target, 120),
        auditField(entry.ip, 45),
        auditField(entry.ua, 300),
        entry.meta ? JSON.stringify(entry.meta) : null,
      ],
    );
  } catch {
    /* audit must never break the request path */
  }
}
