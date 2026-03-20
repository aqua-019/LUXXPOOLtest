/**
 * LUXXPOOL — Migration 006: Security Engine Schema
 * Nine-layer security engine tables: security_events, miner_reputation,
 * reputation_history, and helper views for operator dashboard.
 */

const MIGRATION_SQL = `

-- Backup old security_events table from v0.3.x if it exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'security_events') THEN
    ALTER TABLE security_events RENAME TO security_events_v03_backup;
  END IF;
END;
$$;

-- Security Events (Layer 9 — Audit Trail)
CREATE TABLE security_events (
  id             BIGSERIAL PRIMARY KEY,
  layer          SMALLINT      NOT NULL CHECK (layer BETWEEN 1 AND 9),
  result         VARCHAR(16)   NOT NULL CHECK (result IN ('pass','flag','reject','ban')),
  reason         TEXT          NOT NULL,
  severity       VARCHAR(16)   NOT NULL DEFAULT 'info'
                 CHECK (severity IN ('info','low','medium','high','critical')),
  client_id      VARCHAR(64),
  ip_address     INET,
  miner_address  VARCHAR(64),
  meta           JSONB         NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Indexes for operator dashboard queries
CREATE INDEX idx_sec_events_created  ON security_events (created_at DESC);
CREATE INDEX idx_sec_events_layer    ON security_events (layer);
CREATE INDEX idx_sec_events_severity ON security_events (severity) WHERE severity IN ('high','critical');
CREATE INDEX idx_sec_events_address  ON security_events (miner_address) WHERE miner_address IS NOT NULL;
CREATE INDEX idx_sec_events_ip       ON security_events (ip_address)    WHERE ip_address IS NOT NULL;

-- Miner Reputation (Layer 8 — Reputation Engine)
-- Mirrors Redis scores with full history for audit purposes.
CREATE TABLE IF NOT EXISTS miner_reputation (
  address        VARCHAR(64)   PRIMARY KEY,
  score          SMALLINT      NOT NULL DEFAULT 500 CHECK (score BETWEEN 0 AND 1000),
  total_shares   BIGINT        NOT NULL DEFAULT 0,
  total_blocks   INTEGER       NOT NULL DEFAULT 0,
  penalty_count  INTEGER       NOT NULL DEFAULT 0,
  reward_count   INTEGER       NOT NULL DEFAULT 0,
  last_seen      TIMESTAMPTZ,
  first_seen     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rep_score      ON miner_reputation (score);
CREATE INDEX IF NOT EXISTS idx_rep_last_seen  ON miner_reputation (last_seen DESC);

-- Reputation Score History
CREATE TABLE IF NOT EXISTS reputation_history (
  id          BIGSERIAL PRIMARY KEY,
  address     VARCHAR(64)  NOT NULL,
  delta       SMALLINT     NOT NULL,
  score_after SMALLINT     NOT NULL,
  reason      TEXT         NOT NULL,
  severity    VARCHAR(16),
  event_layer SMALLINT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rep_history_address ON reputation_history (address);
CREATE INDEX IF NOT EXISTS idx_rep_history_created ON reputation_history (created_at DESC);

-- Banned IPs (updated for v0.7.0 — add source_layer column)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'banned_ips' AND column_name = 'source_layer'
  ) THEN
    ALTER TABLE banned_ips ADD COLUMN source_layer SMALLINT DEFAULT NULL;
  END IF;
END;
$$;

-- Helper view: recent HIGH+ events
CREATE OR REPLACE VIEW v_security_alerts AS
SELECT
  id, layer, result, reason, severity,
  client_id, ip_address, miner_address,
  meta, created_at
FROM security_events
WHERE severity IN ('high', 'critical')
ORDER BY created_at DESC;

-- Helper view: miner threat summary
CREATE OR REPLACE VIEW v_miner_threat_summary AS
SELECT
  e.miner_address,
  r.score                                    AS reputation_score,
  COUNT(*)                                   AS total_events,
  COUNT(*) FILTER (WHERE e.result = 'ban')   AS bans,
  COUNT(*) FILTER (WHERE e.result = 'flag')  AS flags,
  MAX(e.created_at)                          AS last_event,
  jsonb_agg(DISTINCT e.severity)             AS severities
FROM security_events e
LEFT JOIN miner_reputation r ON r.address = e.miner_address
WHERE e.miner_address IS NOT NULL
  AND e.created_at > NOW() - INTERVAL '7 days'
GROUP BY e.miner_address, r.score
ORDER BY bans DESC, flags DESC;

`;

module.exports = { MIGRATION_SQL };
