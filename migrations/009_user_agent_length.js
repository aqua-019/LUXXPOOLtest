/**
 * LUXXPOOL — Migration 009: Cap user_agent column to 256 characters
 * Prevents DB bloat from crafted user-agent strings.
 * Truncates existing rows that exceed the limit.
 */

const MIGRATION_SQL = `

UPDATE workers SET user_agent = LEFT(user_agent, 256) WHERE LENGTH(user_agent) > 256;

DO $$
BEGIN
  ALTER TABLE workers ALTER COLUMN user_agent TYPE VARCHAR(256);
EXCEPTION WHEN others THEN
  -- Column may already be typed or type change not needed
  NULL;
END;
$$;

`;

module.exports = { MIGRATION_SQL };
