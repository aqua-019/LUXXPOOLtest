/**
 * LUXXPOOL — Database Migration: Initial Schema
 * Creates all tables for pool operation
 */

const MIGRATION_SQL = `

-- ═══════════════════════════════════════════════════════════
-- MINERS / ACCOUNTS
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS miners (
  id              SERIAL PRIMARY KEY,
  address         VARCHAR(128) UNIQUE NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_seen       TIMESTAMPTZ DEFAULT NOW(),
  min_payout      NUMERIC(20,8) DEFAULT 0.01,
  total_paid      NUMERIC(20,8) DEFAULT 0,
  total_shares    BIGINT DEFAULT 0,
  is_active       BOOLEAN DEFAULT true
);

CREATE INDEX idx_miners_address ON miners(address);
CREATE INDEX idx_miners_active  ON miners(is_active) WHERE is_active = true;

-- ═══════════════════════════════════════════════════════════
-- WORKERS (sub-identities per miner)
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS workers (
  id              SERIAL PRIMARY KEY,
  miner_id        INT REFERENCES miners(id),
  name            VARCHAR(128) NOT NULL,
  full_name       VARCHAR(256) NOT NULL,  -- "address.workerName"
  hashrate        NUMERIC DEFAULT 0,
  difficulty      NUMERIC DEFAULT 512,
  last_share      TIMESTAMPTZ,
  is_online       BOOLEAN DEFAULT false,
  ip_address      INET,
  user_agent      VARCHAR(256),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_workers_miner    ON workers(miner_id);
CREATE INDEX idx_workers_online   ON workers(is_online) WHERE is_online = true;
CREATE INDEX idx_workers_fullname ON workers(full_name);

-- ═══════════════════════════════════════════════════════════
-- SHARES
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS shares (
  id              BIGSERIAL PRIMARY KEY,
  worker          VARCHAR(256) NOT NULL,
  address         VARCHAR(128) NOT NULL,
  difficulty      NUMERIC NOT NULL,
  height          BIGINT NOT NULL,
  ip              INET,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Partitioning-ready index (partition by created_at for large pools)
CREATE INDEX idx_shares_address   ON shares(address);
CREATE INDEX idx_shares_height    ON shares(height);
CREATE INDEX idx_shares_created   ON shares(created_at);

-- ═══════════════════════════════════════════════════════════
-- BLOCKS FOUND
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS blocks (
  id              SERIAL PRIMARY KEY,
  height          BIGINT NOT NULL,
  hash            VARCHAR(128),
  reward          BIGINT NOT NULL,           -- in litoshis
  worker          VARCHAR(256),
  address         VARCHAR(128),
  difficulty      VARCHAR(32),
  confirmations   INT DEFAULT 0,
  confirmed       BOOLEAN DEFAULT false,
  orphaned        BOOLEAN DEFAULT false,
  coin            VARCHAR(10) DEFAULT 'LTC',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_blocks_height    ON blocks(height);
CREATE INDEX idx_blocks_confirmed ON blocks(confirmed);

-- ═══════════════════════════════════════════════════════════
-- PAYMENTS
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payments (
  id              SERIAL PRIMARY KEY,
  address         VARCHAR(128) NOT NULL,
  amount          NUMERIC(20,8) NOT NULL,
  txid            VARCHAR(128),
  fee             NUMERIC(20,8) DEFAULT 0,
  coin            VARCHAR(10) DEFAULT 'LTC',
  status          VARCHAR(20) DEFAULT 'pending',  -- pending, sent, confirmed, failed
  block_height    BIGINT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  confirmed_at    TIMESTAMPTZ
);

CREATE INDEX idx_payments_address ON payments(address);
CREATE INDEX idx_payments_status  ON payments(status);
CREATE INDEX idx_payments_txid    ON payments(txid);

-- ═══════════════════════════════════════════════════════════
-- POOL STATISTICS (time-series snapshots)
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pool_stats (
  id              SERIAL PRIMARY KEY,
  hashrate        NUMERIC DEFAULT 0,
  miners_active   INT DEFAULT 0,
  workers_active  INT DEFAULT 0,
  shares_per_sec  NUMERIC DEFAULT 0,
  network_diff    NUMERIC DEFAULT 0,
  network_hashrate NUMERIC DEFAULT 0,
  block_height    BIGINT,
  ltc_price_usd   NUMERIC(10,2),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pool_stats_time ON pool_stats(created_at);

-- ═══════════════════════════════════════════════════════════
-- MINER HASHRATE HISTORY
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS miner_hashrate (
  id              SERIAL PRIMARY KEY,
  address         VARCHAR(128) NOT NULL,
  hashrate        NUMERIC NOT NULL,
  worker_count    INT DEFAULT 1,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_miner_hashrate_addr ON miner_hashrate(address);
CREATE INDEX idx_miner_hashrate_time ON miner_hashrate(created_at);

-- ═══════════════════════════════════════════════════════════
-- BANNING TABLE (DDoS / abuse)
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS banned_ips (
  id              SERIAL PRIMARY KEY,
  ip_address      INET NOT NULL,
  reason          VARCHAR(256),
  banned_at       TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,
  permanent       BOOLEAN DEFAULT false
);

CREATE INDEX idx_banned_ip ON banned_ips(ip_address);

-- ═══════════════════════════════════════════════════════════
-- ROUND TRACKING (for PPLNS)
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rounds (
  id              SERIAL PRIMARY KEY,
  height          BIGINT NOT NULL,
  total_shares    BIGINT DEFAULT 0,
  reward          BIGINT DEFAULT 0,
  status          VARCHAR(20) DEFAULT 'open',  -- open, closed, paid
  block_id        INT REFERENCES blocks(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  closed_at       TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ
);

CREATE INDEX idx_rounds_height ON rounds(height);
CREATE INDEX idx_rounds_status ON rounds(status);

`;

module.exports = { MIGRATION_SQL };
