/**
 * LUXXPOOL — Migration 008: Add solo mining columns to blocks table
 * Tracks whether a block was found by a solo miner and their applicable fee.
 */

const MIGRATION_SQL = `

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blocks' AND column_name = 'is_solo'
  ) THEN
    ALTER TABLE blocks ADD COLUMN is_solo BOOLEAN NOT NULL DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blocks' AND column_name = 'solo_fee'
  ) THEN
    ALTER TABLE blocks ADD COLUMN solo_fee NUMERIC(6,4) NOT NULL DEFAULT 0;
  END IF;
END;
$$;

`;

module.exports = { MIGRATION_SQL };
