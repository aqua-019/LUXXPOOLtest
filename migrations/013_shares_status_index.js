/**
 * LUXXPOOL — Migration 013: composite partial index on (height, status) for PPLNS
 * Speeds up the status-filtered PPLNS query introduced in v0.8.3 (C-1).
 */

const MIGRATION_SQL = `

CREATE INDEX IF NOT EXISTS idx_shares_height_status
  ON shares (height, status)
  WHERE status = 'valid';

`;

module.exports = { MIGRATION_SQL };
