-- Sidebar thumbnails for image and poster outputs.
--
-- kind gains 'thumbnail' after the existing values so stored enum indexes
-- stay valid. Re-runnable: skip the MODIFY once COLUMN_TYPE already lists
-- thumbnail. This file does not drop foreign keys and does not partition
-- any table.

SET @has_thumbnail := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'task_outputs'
    AND COLUMN_NAME = 'kind'
    AND COLUMN_TYPE LIKE '%thumbnail%'
);
SET @sql := IF(
  @has_thumbnail = 0,
  'ALTER TABLE task_outputs MODIFY COLUMN kind ENUM(''image'',''video'',''poster'',''sprite'',''audio'',''thumbnail'') NOT NULL',
  'DO 0'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
