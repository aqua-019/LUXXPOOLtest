/**
 * LUXXPOOL v0.7.0 — Database Migration
 * Adds tables for: miner firmware tracking, IP reputation,
 * audit logging, miner performance metrics.
 * Extends workers table with model/firmware columns.
 */

const MIGRATION_SQL = `

-- ═══════════════════════════════════════════════════════════
-- MINER FIRMWARE TRACKING
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS miner_firmware (
  id               SERIAL PRIMARY KEY,
  address          VARCHAR(128) NOT NULL,
  worker_name      VARCHAR(256),
  miner_model      VARCHAR(128),
  firmware_version VARCHAR(64),
  user_agent       VARCHAR(512),
  first_seen       TIMESTAMPTZ DEFAULT NOW(),
  last_seen        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(address, worker_name)
);

CREATE INDEX IF NOT EXISTS idx_firmware_model   ON miner_firmware(miner_model);
CREATE INDEX IF NOT EXISTS idx_firmware_version ON miner_firmware(firmware_version);
CREATE INDEX IF NOT EXISTS idx_firmware_address ON miner_firmware(address);

-- ═══════════════════════════════════════════════════════════
-- IP REPUTATION
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ip_reputation (
  id              SERIAL PRIMARY KEY,
  ip_address      INET UNIQUE NOT NULL,
  score           INT DEFAULT 50,
  total_events    INT DEFAULT 0,
  ban_count       INT DEFAULT 0,
  last_event      TIMESTAMPTZ,
  first_seen      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ip_rep_score ON ip_reputation(score);
CREATE INDEX IF NOT EXISTS idx_ip_rep_ip    ON ip_reputation(ip_address);

-- ═══════════════════════════════════════════════════════════
-- AUDIT LOG
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGSERIAL PRIMARY KEY,
  event_type      VARCHAR(64) NOT NULL,
  severity        VARCHAR(16) DEFAULT 'info',
  source_ip       INET,
  target          VARCHAR(256),
  details         JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_type     ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_time     ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_log(severity);

-- ═══════════════════════════════════════════════════════════
-- MINER PERFORMANCE TRACKING
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS miner_performance (
  id                SERIAL PRIMARY KEY,
  address           VARCHAR(128) NOT NULL,
  worker_name       VARCHAR(256),
  miner_model       VARCHAR(128),
  expected_hashrate NUMERIC,
  actual_hashrate   NUMERIC,
  efficiency        NUMERIC(5,2),
  stale_rate        NUMERIC(5,4),
  sample_period     INT DEFAULT 3600,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_perf_address ON miner_performance(address);
CREATE INDEX IF NOT EXISTS idx_perf_model   ON miner_performance(miner_model);
CREATE INDEX IF NOT EXISTS idx_perf_time    ON miner_performance(created_at);

-- ═══════════════════════════════════════════════════════════
-- EXTEND WORKERS TABLE
-- ═══════════════════════════════════════════════════════════

ALTER TABLE workers ADD COLUMN IF NOT EXISTS miner_model VARCHAR(128);
ALTER TABLE workers ADD COLUMN IF NOT EXISTS firmware_version VARCHAR(64);

`;

module.exports = { MIGRATION_SQL };
