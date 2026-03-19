/**
 * LUXXPOOL — Migration 003: Security Infrastructure
 * Triple-layered security tables
 */

const MIGRATION_SQL = `

-- Security events log (all 3 layers)
CREATE TABLE IF NOT EXISTS security_events (
  id              BIGSERIAL PRIMARY KEY,
  type            VARCHAR(50) NOT NULL,
  ip              INET,
  address         VARCHAR(128),
  severity        VARCHAR(10) DEFAULT 'LOW',
  details         JSONB,
  resolved        BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_security_type ON security_events(type);
CREATE INDEX idx_security_ip ON security_events(ip);
CREATE INDEX idx_security_created ON security_events(created_at);
CREATE INDEX idx_security_severity ON security_events(severity);

-- API rate limiting tracking
CREATE TABLE IF NOT EXISTS api_rate_limits (
  id              SERIAL PRIMARY KEY,
  ip              INET NOT NULL,
  endpoint        VARCHAR(256),
  requests        INT DEFAULT 1,
  window_start    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ip, endpoint, window_start)
);

-- Address validation cache
CREATE TABLE IF NOT EXISTS validated_addresses (
  address         VARCHAR(128) PRIMARY KEY,
  coin            VARCHAR(10) NOT NULL,
  valid           BOOLEAN NOT NULL,
  validated_at    TIMESTAMPTZ DEFAULT NOW()
);

`;

module.exports = { MIGRATION_SQL };
