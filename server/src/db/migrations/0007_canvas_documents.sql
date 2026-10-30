CREATE TABLE IF NOT EXISTS canvas_documents (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  org_id        CHAR(36)     NOT NULL,
  user_id       CHAR(36)     NOT NULL,
  name          VARCHAR(120) NOT NULL DEFAULT '我的画布',
  document_json JSON         NOT NULL,
  version       INT UNSIGNED NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_canvas_user_org (user_id, org_id),
  KEY idx_canvas_org_updated (org_id, updated_at),
  CONSTRAINT fk_canvas_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_canvas_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
