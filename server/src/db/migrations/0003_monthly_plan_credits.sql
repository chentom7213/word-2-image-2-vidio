-- 0003_monthly_plan_credits.sql
--
-- Durable, idempotent ledger for subscription credit grants.  A scheduler may
-- be run by more than one API/worker replica: the unique period key means a
-- customer can still receive a grant exactly once.

CREATE TABLE IF NOT EXISTS monthly_credit_grants (
  id           CHAR(36)    NOT NULL PRIMARY KEY,
  user_id      CHAR(36)    NOT NULL,
  plan_id      VARCHAR(32) NOT NULL,
  period_start DATETIME    NOT NULL,
  credits      INT         NOT NULL,
  source_order_id CHAR(36) NULL,
  created_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_monthly_credit_period (user_id, plan_id, period_start),
  UNIQUE KEY uk_monthly_credit_order (source_order_id),
  KEY idx_monthly_credit_due (user_id, plan_id, period_start),
  CONSTRAINT fk_monthly_credit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_monthly_credit_order FOREIGN KEY (source_order_id) REFERENCES orders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Preserve the first paid period for subscriptions that existed before this
-- migration.  This stops the scheduler from issuing a second "first month"
-- grant as soon as the new code is deployed.
INSERT IGNORE INTO monthly_credit_grants
  (id, user_id, plan_id, period_start, credits, source_order_id, created_at)
SELECT UUID(), o.user_id, o.sku_id, COALESCE(o.paid_at, o.created_at), o.credits, o.id,
       COALESCE(o.paid_at, o.created_at)
FROM orders o
WHERE o.kind = 'plan' AND o.status = 'paid' AND o.credits > 0;
