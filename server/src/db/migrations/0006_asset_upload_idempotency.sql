-- A signed upload may be confirmed more than once after a client retry. Collapse
-- any historical duplicates before enforcing one asset row per uploaded object.
DELETE gr_dup
  FROM generation_refs gr_dup
  JOIN assets dup ON dup.id = gr_dup.asset_id
  JOIN assets keep ON keep.user_id = dup.user_id AND keep.url = dup.url AND keep.id < dup.id
  JOIN generation_refs gr_keep ON gr_keep.task_id = gr_dup.task_id AND gr_keep.asset_id = keep.id;

UPDATE generation_refs gr
JOIN assets dup ON dup.id = gr.asset_id
JOIN assets keep ON keep.user_id = dup.user_id AND keep.url = dup.url AND keep.id < dup.id
SET gr.asset_id = keep.id;

DELETE dup
  FROM assets dup
  JOIN assets keep ON keep.user_id = dup.user_id AND keep.url = dup.url AND keep.id < dup.id;

SET @asset_unique_sql = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'assets' AND INDEX_NAME = 'uk_asset_user_url') = 0,
  'ALTER TABLE assets ADD UNIQUE KEY uk_asset_user_url (user_id, url)',
  'SELECT 1'
);
PREPARE asset_unique_stmt FROM @asset_unique_sql;
EXECUTE asset_unique_stmt;
DEALLOCATE PREPARE asset_unique_stmt;
