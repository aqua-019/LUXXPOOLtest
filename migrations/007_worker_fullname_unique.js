/**
 * LUXXPOOL — Migration 007: Worker full_name UNIQUE constraint
 * Ensures no duplicate worker entries can be created for the same full_name.
 * The ON CONFLICT (full_name) upserts in workerTracker already assume uniqueness.
 */

const MIGRATION_SQL = `

-- Add UNIQUE constraint on workers.full_name if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workers_full_name_unique'
  ) THEN
    -- Remove any duplicates first (keep the most recent)
    DELETE FROM workers w1
    USING workers w2
    WHERE w1.full_name = w2.full_name
      AND w1.id < w2.id;

    ALTER TABLE workers
      ADD CONSTRAINT workers_full_name_unique UNIQUE (full_name);
  END IF;
END;
$$;

`;

module.exports = { MIGRATION_SQL };
