-- OIDC identities are deliberately separate from users.  Email alone is not a
-- durable federated identifier: an IdP subject (`sub`) is issuer-scoped and
-- remains stable when an employee changes their display name or email alias.
CREATE TABLE IF NOT EXISTS oidc_identities (
  issuer       VARCHAR(500) NOT NULL,
  subject      VARCHAR(255) NOT NULL,
  user_id      CHAR(36)     NOT NULL,
  email_at_link VARCHAR(190) NOT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (issuer, subject),
  KEY idx_oidc_identity_user (user_id),
  CONSTRAINT fk_oidc_identity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
