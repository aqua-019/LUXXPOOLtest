/**
 * LUXXPOOL — Migration 010: Fee Transparency Ledger
 * Public audit trail of fees collected per block.
 */

const MIGRATION_SQL = `

CREATE TABLE IF NOT EXISTS block_fee_ledger (
  id             SERIAL PRIMARY KEY,
  coin           VARCHAR(10) NOT NULL,
  block_height   BIGINT NOT NULL,
  gross_reward   NUMERIC(20,8) NOT NULL,
  pool_fee_pct   NUMERIC(6,4) NOT NULL,
  pool_fee_amount NUMERIC(20,8) NOT NULL,
  net_distributed NUMERIC(20,8) NOT NULL,
  miner_count    INTEGER NOT NULL,
  payout_txid    VARCHAR(64),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(coin, block_height)
);

CREATE INDEX IF NOT EXISTS idx_fee_ledger_created ON block_fee_ledger (created_at DESC);

`;

module.exports = { MIGRATION_SQL };
