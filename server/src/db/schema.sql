-- BenchU Canvas schema (MySQL 8+)
-- Charset utf8mb4 for full CJK/emoji support.
-- All statements are idempotent; column-level upgrades live in src/db/init.ts.

CREATE TABLE IF NOT EXISTS users (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  email         VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(80)  NULL,
  credits       INT          NOT NULL DEFAULT 1000,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at          DATETIME     NULL,
  suspended_at        DATETIME     NULL,
  tokens_valid_after  DATETIME(3)  NULL,
  password_set        TINYINT(1)   NOT NULL DEFAULT 1,
  KEY idx_users_deleted_at (deleted_at),
  KEY idx_users_suspended_at (suspended_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 模型注册表：价格/能力以 DB 为准，前端不再硬编码 ────────────────────
CREATE TABLE IF NOT EXISTS model_registry (
  id             VARCHAR(64)  NOT NULL PRIMARY KEY,
  provider       VARCHAR(64)  NOT NULL,
  display_name   VARCHAR(120) NOT NULL,
  kind           ENUM('image','video') NOT NULL,
  price_unit     ENUM('per_second','per_call','per_image') NOT NULL,
  price_amount   INT          NOT NULL,
  max_duration   INT          NULL,
  resolutions    JSON         NULL,
  capabilities   JSON         NULL,
  provider_model VARCHAR(120) NOT NULL,
  enabled        TINYINT(1)   NOT NULL DEFAULT 1,
  sort_weight    INT          NOT NULL DEFAULT 0,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS generation_tasks (
  org_id      CHAR(36)     NULL,  -- tenant scope (nullable for legacy rows)
  -- Private by default.  `org` only grants read access to active members of
  -- this exact organization; it never grants mutation rights.
  visibility  ENUM('private','org') NOT NULL DEFAULT 'private',
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  user_id      CHAR(36)     NOT NULL,
  type         ENUM('image','video') NOT NULL,
  prompt       TEXT         NOT NULL,
  model_id     VARCHAR(64)  NOT NULL,
  model_name   VARCHAR(120) NOT NULL,
  resolution   VARCHAR(16)  NULL,
  width        INT          NOT NULL DEFAULT 0,
  height       INT          NOT NULL DEFAULT 0,
  duration     INT          NOT NULL DEFAULT 0,
  `count`      INT          NOT NULL DEFAULT 1,
  status       ENUM('queued','running','done','failed') NOT NULL DEFAULT 'queued',
  progress     TINYINT      NOT NULL DEFAULT 0,
  seed         VARCHAR(80)  NOT NULL,
  result_url   VARCHAR(500) NULL,
  poster_url   VARCHAR(500) NULL,
  credits_cost INT          NOT NULL DEFAULT 0,
  cost_actual  INT          NOT NULL DEFAULT 0,
  error        VARCHAR(500) NULL,
  error_code   VARCHAR(40)  NULL,
  idempotency_key VARCHAR(80) NULL,
  priority     TINYINT      NOT NULL DEFAULT 5,
  attempts     TINYINT      NOT NULL DEFAULT 0,
  max_attempts TINYINT      NOT NULL DEFAULT 3,
  next_attempt_at DATETIME(3) NULL,
  provider_job_id VARCHAR(120) NULL,
  trace_id     VARCHAR(64)  NULL,
  started_at   DATETIME     NULL,
  finished_at  DATETIME     NULL,
  heartbeat_at DATETIME     NULL,
  refunded_at  DATETIME     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_task_idem (user_id, idempotency_key),
  KEY idx_task_user (user_id, created_at),
  KEY idx_task_org_visibility (org_id, visibility, created_at),
  KEY idx_task_pick (status, priority, created_at),
  KEY idx_task_running (status, heartbeat_at),
  CONSTRAINT fk_task_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 产物：1 任务 N 产物（4 张图 / 1 视频 + 封面）────────────────────────
CREATE TABLE IF NOT EXISTS task_outputs (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  task_id     CHAR(36)     NOT NULL,
  kind        ENUM('image','video','poster','sprite','audio','thumbnail') NOT NULL,
  object_key  VARCHAR(500) NOT NULL,
  mime        VARCHAR(80)  NOT NULL,
  width       INT          NULL,
  height      INT          NULL,
  duration    INT          NULL,
  bytes       BIGINT       NULL,
  sha256      CHAR(64)     NULL,
  watermarked TINYINT(1)   NOT NULL DEFAULT 0,
  sort_order  INT          NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_out_task (task_id, sort_order),
  CONSTRAINT fk_out_task FOREIGN KEY (task_id) REFERENCES generation_tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS assets (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  org_id     CHAR(36)     NULL,
  user_id    CHAR(36)     NOT NULL,
  filename   VARCHAR(255) NOT NULL,
  url        VARCHAR(500) NOT NULL,
  size       INT          NOT NULL DEFAULT 0,
  mime       VARCHAR(120) NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_asset_user (user_id, created_at),
  UNIQUE KEY uk_asset_user_url (user_id, url),
  CONSTRAINT fk_asset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS generation_refs (
  task_id  CHAR(36) NOT NULL,
  asset_id CHAR(36) NOT NULL,
  kind     ENUM('image','video','audio') NOT NULL,
  PRIMARY KEY (task_id, asset_id),
  KEY idx_ref_task (task_id),
  CONSTRAINT fk_ref_task  FOREIGN KEY (task_id)  REFERENCES generation_tasks(id) ON DELETE CASCADE,
  CONSTRAINT fk_ref_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

CREATE TABLE IF NOT EXISTS credit_transactions (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  user_id      CHAR(36)     NOT NULL,
  delta        INT          NOT NULL,
  balance_after INT         NOT NULL,
  reason       VARCHAR(120) NOT NULL,
  ref_id       CHAR(36)     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tx_user (user_id, created_at),
  CONSTRAINT fk_tx_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS organizations (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  name       VARCHAR(120) NOT NULL,
  plan       ENUM('free','pro','enterprise') NOT NULL DEFAULT 'free',
  credits    BIGINT       NOT NULL DEFAULT 0,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS memberships (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  org_id     CHAR(36)     NOT NULL,
  user_id    CHAR(36)     NOT NULL,
  role       ENUM('owner','admin','editor','viewer') NOT NULL DEFAULT 'viewer',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_org_user (org_id, user_id),
  KEY idx_member_user (user_id),
  CONSTRAINT fk_mem_org  FOREIGN KEY (org_id)  REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_mem_user FOREIGN KEY (user_id) REFERENCES users(id)         ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_keys (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  org_id      CHAR(36)     NOT NULL,
  name        VARCHAR(80)  NOT NULL,
  key_prefix  VARCHAR(12)  NOT NULL,
  key_hash    CHAR(64)     NOT NULL,
  scopes      JSON         NOT NULL,
  rate_limit  INT          NOT NULL DEFAULT 60,
  expires_at  DATETIME     NULL,
  last_used_at DATETIME    NULL,
  revoked_at  DATETIME     NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_key_hash (key_hash),
  KEY idx_key_org (org_id),
  CONSTRAINT fk_key_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id     CHAR(36)   NULL,
  user_id    CHAR(36)   NULL,
  action     VARCHAR(80) NOT NULL,
  target     VARCHAR(120) NULL,
  ip         VARCHAR(45) NULL,
  ua         VARCHAR(300) NULL,
  meta       JSON       NULL,
  created_at DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_user (user_id, created_at),
  KEY idx_audit_action (action, created_at),
  KEY idx_audit_org (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 审计冷归档。没有外键，避免和热表的业务外键缠在一起。
CREATE TABLE IF NOT EXISTS audit_logs_archive (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id     CHAR(36)   NULL,
  user_id    CHAR(36)   NULL,
  action     VARCHAR(80) NOT NULL,
  target     VARCHAR(120) NULL,
  ip         VARCHAR(45) NULL,
  ua         VARCHAR(300) NULL,
  meta       JSON       NULL,
  created_at DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_user (user_id, created_at),
  KEY idx_audit_action (action, created_at),
  KEY idx_audit_org (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 会话（refresh token 旋转）──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  user_id    CHAR(36)     NOT NULL,
  family_id  CHAR(36)     NOT NULL,
  token_hash CHAR(64)     NOT NULL,
  expires_at DATETIME     NOT NULL,
  revoked_at DATETIME     NULL,
  replaced_by CHAR(36)    NULL,
  ip         VARCHAR(45)  NULL,
  user_agent VARCHAR(300) NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_rt_hash (token_hash),
  KEY idx_rt_user (user_id, expires_at),
  KEY idx_rt_family (family_id),
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 套餐（定价与配额的服务端权威源）────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id              VARCHAR(32)  NOT NULL PRIMARY KEY,
  name            VARCHAR(80)  NOT NULL,
  -- 月费（分）。0 表示免费档。
  price_cents     INT          NOT NULL DEFAULT 0,
  -- 每月赠送积分；NULL 表示不自动发放（按次付费，走充值包）。
  monthly_credits INT          NULL,
  -- 同时在跑的任务上限。这是保护 worker 的关键旋钮。
  max_concurrent  INT          NOT NULL DEFAULT 1,
  -- 每模型最大时长（秒）与每分钟请求数。
  max_duration    INT          NOT NULL DEFAULT 10,
  rpm             INT          NOT NULL DEFAULT 30,
  features        JSON         NULL,
  enabled         TINYINT(1)   NOT NULL DEFAULT 1,
  sort_weight     INT          NOT NULL DEFAULT 0,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 充值包（固定面额，不随套餐）────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_packs (
  id          VARCHAR(32) NOT NULL PRIMARY KEY,
  name        VARCHAR(80) NOT NULL,
  credits     INT         NOT NULL,
  -- 实付金额（分）。与 credits 的比值决定单价。
  price_cents INT         NOT NULL,
  bonus       INT         NOT NULL DEFAULT 0,
  enabled     TINYINT(1)  NOT NULL DEFAULT 1,
  sort_weight INT         NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 订单（一次购买 = 一个订单）────────────────────────────────────────
-- 金额与积分数一律从 plans / credit_packs 读取后快照到这里，
-- 绝不接受客户端传入的价格。
CREATE TABLE IF NOT EXISTS orders (
  id               CHAR(36)    NOT NULL PRIMARY KEY,
  org_id           CHAR(36)    NULL,
  user_id          CHAR(36)    NOT NULL,
  kind             ENUM('plan','credits') NOT NULL,
  -- plans.id 或 credit_packs.id
  sku_id           VARCHAR(32) NOT NULL,
  sku_name         VARCHAR(80) NOT NULL,
  amount_cents     INT         NOT NULL,
  credits          INT         NOT NULL,
  status           ENUM('pending','paid','failed','refunded','expired') NOT NULL DEFAULT 'pending',
  provider         VARCHAR(32) NULL,
  provider_order_id VARCHAR(120) NULL,
  pay_url          VARCHAR(2048) NULL,
  idempotency_key  VARCHAR(80) NULL,
  -- 支付凭证（支付宝交易号 / 微信 transaction_id），用于对账
  provider_txn_id  VARCHAR(120) NULL,
  paid_at          DATETIME    NULL,
  expires_at       DATETIME    NOT NULL,
  created_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_order_idem (user_id, idempotency_key),
  UNIQUE KEY uk_order_provider (provider, provider_order_id),
  KEY idx_order_user (user_id, created_at),
  KEY idx_order_status (status, created_at),
  CONSTRAINT fk_order_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 支付回调事件（幂等去重，支付网关必然会重试）──────────────────────
CREATE TABLE IF NOT EXISTS payment_events (
  id           CHAR(36)    NOT NULL PRIMARY KEY,
  provider     VARCHAR(32) NOT NULL,
  -- 网关侧事件唯一 ID。同一事件重复投递只处理一次。
  event_id     VARCHAR(120) NOT NULL,
  order_id     CHAR(36)    NULL,
  event_type   VARCHAR(40) NOT NULL,
  payload      JSON        NULL,
  -- 'processed' | 'duplicate' | 'ignored' | 'rejected'
  outcome      VARCHAR(20) NOT NULL,
  created_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_provider_event (provider, event_id),
  KEY idx_pe_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 企业 SSO 身份。subject 按 issuer 隔离，不拿邮箱当永久标识。
CREATE TABLE IF NOT EXISTS oidc_identities (
  issuer        VARCHAR(500) NOT NULL,
  subject       VARCHAR(255) NOT NULL,
  user_id       CHAR(36)     NOT NULL,
  email_at_link VARCHAR(190) NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (issuer, subject),
  KEY idx_oidc_identity_user (user_id),
  CONSTRAINT fk_oidc_identity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 套餐月度积分发放账本。同一用户、套餐、周期只记一次。
CREATE TABLE IF NOT EXISTS monthly_credit_grants (
  id              CHAR(36)    NOT NULL PRIMARY KEY,
  user_id         CHAR(36)    NOT NULL,
  plan_id         VARCHAR(32) NOT NULL,
  period_start    DATETIME    NOT NULL,
  credits         INT         NOT NULL,
  source_order_id CHAR(36)    NULL,
  created_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_monthly_credit_period (user_id, plan_id, period_start),
  UNIQUE KEY uk_monthly_credit_order (source_order_id),
  KEY idx_monthly_credit_due (user_id, plan_id, period_start),
  CONSTRAINT fk_monthly_credit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_monthly_credit_order FOREIGN KEY (source_order_id) REFERENCES orders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
