/**
 * LUXXPOOL — Migration 005: v0.7.0 Features
 * Miner model detection, IP reputation, audit logging, emergency lockdown
 */

const MIGRATION_SQL = `

-- Miner model detection and firmware tracking
CREATE TABLE IF NOT EXISTS miner_models (
  id                BIGSERIAL PRIMARY KEY,
  address           VARCHAR(128) NOT NULL,
  model             VARCHAR(64),
  firmware_version  VARCHAR(64),
  detected_at       TIMESTAMPTZ DEFAULT NOW(),
  optimal_difficulty INT,
  expected_hashrate BIGINT,
  last_seen         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_miner_models_address ON miner_models(address);
CREATE INDEX IF NOT EXISTS idx_miner_models_model ON miner_models(model);

-- IP reputation scoring (0-100, behavioral)
CREATE TABLE IF NOT EXISTS ip_reputation (
  ip_address        INET PRIMARY KEY,
  score             INT DEFAULT 50,
  last_updated      TIMESTAMPTZ DEFAULT NOW(),
  total_valid       BIGINT DEFAULT 0,
  total_invalid     BIGINT DEFAULT 0,
  ban_count         INT DEFAULT 0,
  subnet            VARCHAR(18)
);

CREATE INDEX IF NOT EXISTS idx_ip_reputation_score ON ip_reputation(score);
CREATE INDEX IF NOT EXISTS idx_ip_reputation_subnet ON ip_reputation(subnet);

-- Forensic audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id                BIGSERIAL PRIMARY KEY,
  timestamp         TIMESTAMPTZ DEFAULT NOW(),
  event_type        VARCHAR(64) NOT NULL,
  actor             VARCHAR(128),
  target            VARCHAR(256),
  details           JSONB,
  severity          VARCHAR(10) DEFAULT 'INFO'
);

CREATE INDEX IF NOT EXISTS idx_audit_log_type ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_severity ON audit_log(severity);

-- Emergency lockdown history
CREATE TABLE IF NOT EXISTS lockdown_history (
  id                BIGSERIAL PRIMARY KEY,
  level             INT NOT NULL,
  triggered_by      VARCHAR(128),
  started_at        TIMESTAMPTZ DEFAULT NOW(),
  ended_at          TIMESTAMPTZ,
  reason            TEXT
);

CREATE INDEX IF NOT EXISTS idx_lockdown_started ON lockdown_history(started_at);

`;

module.exports = { MIGRATION_SQL };
