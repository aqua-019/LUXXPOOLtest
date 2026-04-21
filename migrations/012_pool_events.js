/**
 * LUXXPOOL — Migration 012: pool_events table + views + pruning function
 * Adds the persistent event log for the v0.8.2 logging & alert system.
 */

const MIGRATION_SQL = `

CREATE TABLE IF NOT EXISTS pool_events (
  id           BIGSERIAL     PRIMARY KEY,
  code         VARCHAR(16)   NOT NULL,
  category     VARCHAR(32)   NOT NULL,
  severity     VARCHAR(16)   NOT NULL,
  chain        VARCHAR(16),
  address      VARCHAR(64),
  worker       VARCHAR(64),
  diff         NUMERIC(20,0),
  block_height BIGINT,
  txid         VARCHAR(128),
  error_msg    TEXT,
  meta         JSONB         NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pool_events_code     ON pool_events (code);
CREATE INDEX IF NOT EXISTS idx_pool_events_category ON pool_events (category);
CREATE INDEX IF NOT EXISTS idx_pool_events_severity ON pool_events (severity);
CREATE INDEX IF NOT EXISTS idx_pool_events_chain    ON pool_events (chain);
CREATE INDEX IF NOT EXISTS idx_pool_events_address  ON pool_events (address) WHERE address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pool_events_created  ON pool_events (created_at DESC);

-- Recent errors (last 24h, error/critical only)
CREATE OR REPLACE VIEW v_recent_errors AS
  SELECT id, code, category, severity, chain, error_msg, meta, created_at
  FROM pool_events
  WHERE severity IN ('error', 'critical')
    AND created_at > NOW() - INTERVAL '24 hours'
  ORDER BY created_at DESC;

-- Event counts by code in last 1h
CREATE OR REPLACE VIEW v_event_summary_1h AS
  SELECT code, category, severity, COUNT(*) AS cnt
  FROM pool_events
  WHERE created_at > NOW() - INTERVAL '1 hour'
  GROUP BY code, category, severity
  ORDER BY cnt DESC;

-- Block history (submitted/accepted/rejected/orphaned)
CREATE OR REPLACE VIEW v_block_history AS
  SELECT id, code, chain, block_height,
         meta->>'hash'   AS hash,
         (meta->>'reward')::NUMERIC AS reward,
         error_msg,
         created_at
  FROM pool_events
  WHERE code IN ('BLOCK_001', 'BLOCK_002', 'BLOCK_003', 'BLOCK_004')
  ORDER BY created_at DESC;

-- Payment log (LTC sent, aux sent, failures)
CREATE OR REPLACE VIEW v_payment_log AS
  SELECT id, code, chain, address, txid,
         (meta->>'amount')::NUMERIC AS amount,
         error_msg,
         created_at
  FROM pool_events
  WHERE code IN ('PAY_003', 'PAY_004', 'PAY_005')
  ORDER BY created_at DESC;

-- Security log (all security-category events)
CREATE OR REPLACE VIEW v_security_log AS
  SELECT id, code, severity, chain, address, meta, created_at
  FROM pool_events
  WHERE category = 'security'
  ORDER BY created_at DESC;

-- Pruning function
-- Retention policy:
--   - Keep block/payment events forever
--   - Prune info/warn (non-block/payment) older than 14 days
--   - Prune error/critical (non-block/payment) older than 90 days
CREATE OR REPLACE FUNCTION pool_events_prune()
RETURNS TABLE(pruned_info_warn BIGINT, pruned_errors BIGINT) AS $$
DECLARE
  v_iw BIGINT;
  v_er BIGINT;
BEGIN
  DELETE FROM pool_events
   WHERE category NOT IN ('block', 'payment')
     AND severity IN ('info', 'warn')
     AND created_at < NOW() - INTERVAL '14 days';
  GET DIAGNOSTICS v_iw = ROW_COUNT;

  DELETE FROM pool_events
   WHERE category NOT IN ('block', 'payment')
     AND severity IN ('error', 'critical')
     AND created_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS v_er = ROW_COUNT;

  pruned_info_warn := v_iw;
  pruned_errors := v_er;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

`;

module.exports = { MIGRATION_SQL };
