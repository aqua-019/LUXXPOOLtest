/**
 * Migration 004 — Add UNIQUE constraint on banned_ips.ip_address
 * Required for ON CONFLICT (ip_address) DO UPDATE in banningManager.
 */

const MIGRATION_SQL = `
-- Remove duplicate entries if any exist (keep newest by id)
DELETE FROM banned_ips a USING banned_ips b
WHERE a.id < b.id AND a.ip_address = b.ip_address;

-- Add UNIQUE constraint
ALTER TABLE banned_ips ADD CONSTRAINT banned_ips_ip_address_unique UNIQUE (ip_address);
`;

module.exports = { MIGRATION_SQL };
