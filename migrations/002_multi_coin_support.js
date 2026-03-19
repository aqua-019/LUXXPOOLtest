/**
 * LUXXPOOL — Migration 002: Multi-Coin Merged Mining Support
 * Adds wallet registration per coin, aux block tracking, and solo mining tables
 */

const MIGRATION_SQL = `

-- ═══════════════════════════════════════════════════════════
-- MINER WALLET ADDRESSES (per coin)
-- Miners register a wallet for each aux coin to receive rewards
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS miner_wallets (
  id              SERIAL PRIMARY KEY,
  miner_address   VARCHAR(128) NOT NULL,    -- LTC address (primary identifier)
  coin            VARCHAR(10) NOT NULL,      -- DOGE, BELLS, LKY, PEP, etc.
  coin_address    VARCHAR(256) NOT NULL,     -- Wallet address for this coin
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(miner_address, coin)
);

CREATE INDEX idx_miner_wallets_addr ON miner_wallets(miner_address);
CREATE INDEX idx_miner_wallets_coin ON miner_wallets(coin);

-- ═══════════════════════════════════════════════════════════
-- AUXILIARY BLOCKS FOUND
-- Tracks blocks found on each merged-mined chain
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS aux_blocks (
  id              SERIAL PRIMARY KEY,
  coin            VARCHAR(10) NOT NULL,
  height          BIGINT,
  hash            VARCHAR(128),
  parent_hash     VARCHAR(128),              -- LTC block hash that found it
  reward          NUMERIC(30,8),
  worker          VARCHAR(256),
  address         VARCHAR(128),
  confirmations   INT DEFAULT 0,
  confirmed       BOOLEAN DEFAULT false,
  orphaned        BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_aux_blocks_coin ON aux_blocks(coin);
CREATE INDEX idx_aux_blocks_confirmed ON aux_blocks(confirmed);
CREATE INDEX idx_aux_blocks_created ON aux_blocks(created_at);

-- ═══════════════════════════════════════════════════════════
-- SOLO MINING BLOCKS
-- Separate tracking for solo-mined blocks
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS solo_blocks (
  id              SERIAL PRIMARY KEY,
  coin            VARCHAR(10) DEFAULT 'LTC',
  height          BIGINT NOT NULL,
  hash            VARCHAR(128),
  reward          BIGINT NOT NULL,
  miner_address   VARCHAR(128) NOT NULL,
  worker          VARCHAR(256),
  fee_amount      NUMERIC(20,8) DEFAULT 0,
  fee_paid        BOOLEAN DEFAULT false,
  confirmations   INT DEFAULT 0,
  confirmed       BOOLEAN DEFAULT false,
  orphaned        BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_solo_blocks_miner ON solo_blocks(miner_address);
CREATE INDEX idx_solo_blocks_confirmed ON solo_blocks(confirmed);

-- ═══════════════════════════════════════════════════════════
-- COIN STATS (per-coin pool statistics)
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS coin_stats (
  id              SERIAL PRIMARY KEY,
  coin            VARCHAR(10) NOT NULL,
  blocks_found    INT DEFAULT 0,
  total_paid      NUMERIC(30,8) DEFAULT 0,
  network_diff    NUMERIC DEFAULT 0,
  block_height    BIGINT DEFAULT 0,
  last_block_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_coin_stats_coin ON coin_stats(coin);
CREATE INDEX idx_coin_stats_time ON coin_stats(created_at);

-- ═══════════════════════════════════════════════════════════
-- ADD coin COLUMN TO rounds (if not already present)
-- ═══════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rounds' AND column_name = 'coin'
  ) THEN
    ALTER TABLE rounds ADD COLUMN coin VARCHAR(10) DEFAULT 'LTC';
  END IF;
END $$;

`;

module.exports = { MIGRATION_SQL };
