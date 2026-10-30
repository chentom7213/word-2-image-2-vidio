-- Remember the gateway payment link so an idempotent checkout replay can
-- return the same link. Mock orders can rebuild their local link from the
-- order id. Re-runnable. This file does not change foreign keys and does
-- not partition any table.

SET @has_pay_url := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'pay_url'
);
SET @sql := IF(@has_pay_url = 0,
  'ALTER TABLE orders ADD COLUMN pay_url VARCHAR(2048) NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
