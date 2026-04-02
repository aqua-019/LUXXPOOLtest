/**
 * LUXXPOOL — Migration 011: Add status column to shares table
 * Enables logging of rejected and stale shares alongside valid ones.
 */

const MIGRATION_SQL = `

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'shares' AND column_name = 'status'
  ) THEN
    ALTER TABLE shares ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'valid';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'shares' AND column_name = 'rejection_reason'
  ) THEN
    ALTER TABLE shares ADD COLUMN rejection_reason VARCHAR(64);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_shares_status ON shares (status) WHERE status != 'valid';

`;

module.exports = { MIGRATION_SQL };
