'use strict';

/**
 * LUXXPOOL v0.8.2 — Event Code Registry
 *
 * Every observable event in the pool is defined here. Codes are referenced
 * throughout the codebase — do not rename. Order follows the v0.8.2 spec.
 *
 * Fields:
 *   code        — unique string identifier (e.g. 'SHARE_001')
 *   name        — human-readable short description
 *   category    — connection | share | block | auxpow | daemon |
 *                 vardiff | payment | security | system
 *   severity    — info | warn | error | critical
 *   persist     — true = insert into pool_events table; false = stdout only
 *   metric      — Prometheus counter name (auto-registered)
 *   description — one-sentence description for dashboards/docs
 */

const EVENTS = Object.freeze({
  // ─── CONNECTION ──────────────────────────────────────────────────────────
  CONN_001: { code: 'CONN_001', name: 'Miner connected', category: 'connection', severity: 'info',
    persist: false, metric: 'pool_miner_connections_total',
    description: 'A miner TCP socket connected to the stratum server.' },
  CONN_002: { code: 'CONN_002', name: 'Miner disconnected (clean)', category: 'connection', severity: 'info',
    persist: false, metric: 'pool_miner_disconnections_total',
    description: 'A miner disconnected via clean socket close.' },
  CONN_003: { code: 'CONN_003', name: 'Miner disconnected (timeout)', category: 'connection', severity: 'warn',
    persist: false, metric: 'pool_miner_timeouts_total',
    description: 'A miner was disconnected due to socket idle timeout.' },
  CONN_004: { code: 'CONN_004', name: 'Stratum handshake failed', category: 'connection', severity: 'warn',
    persist: true, metric: 'pool_handshake_failures_total',
    description: 'Stratum subscribe handshake could not be completed.' },
  CONN_005: { code: 'CONN_005', name: 'Worker authorized', category: 'connection', severity: 'info',
    persist: false, metric: 'pool_workers_authorized_total',
    description: 'A worker successfully authorized with mining.authorize.' },
  CONN_006: { code: 'CONN_006', name: 'Worker auth failed', category: 'connection', severity: 'warn',
    persist: true, metric: 'pool_auth_failures_total',
    description: 'A mining.authorize attempt failed (invalid address or credentials).' },

  // ─── SHARE ───────────────────────────────────────────────────────────────
  SHARE_001: { code: 'SHARE_001', name: 'Share accepted', category: 'share', severity: 'info',
    persist: false, metric: 'pool_shares_accepted_total',
    description: 'A submitted share met target difficulty and was accepted.' },
  SHARE_002: { code: 'SHARE_002', name: 'Share rejected — stale', category: 'share', severity: 'warn',
    persist: false, metric: 'pool_shares_stale_total',
    description: 'Share was rejected because its job is no longer current.' },
  SHARE_003: { code: 'SHARE_003', name: 'Share rejected — low diff', category: 'share', severity: 'warn',
    persist: false, metric: 'pool_shares_low_diff_total',
    description: 'Share was rejected for failing to meet required difficulty.' },
  SHARE_004: { code: 'SHARE_004', name: 'Share rejected — duplicate', category: 'share', severity: 'warn',
    persist: true, metric: 'pool_shares_duplicate_total',
    description: 'A duplicate share (same nonce) was submitted.' },
  SHARE_005: { code: 'SHARE_005', name: 'Share rejected — invalid', category: 'share', severity: 'error',
    persist: true, metric: 'pool_shares_invalid_total',
    description: 'Share failed hash verification or had malformed fields.' },
  SHARE_006: { code: 'SHARE_006', name: 'Share flood detected', category: 'share', severity: 'warn',
    persist: true, metric: 'pool_share_flood_events_total',
    description: 'A client exceeded the per-minute share submission limit.' },

  // ─── BLOCK ───────────────────────────────────────────────────────────────
  BLOCK_001: { code: 'BLOCK_001', name: 'Block candidate submitted', category: 'block', severity: 'info',
    persist: true, metric: 'pool_blocks_submitted_total',
    description: 'A candidate block was submitted to the daemon via submitblock.' },
  BLOCK_002: { code: 'BLOCK_002', name: 'Block accepted by network', category: 'block', severity: 'info',
    persist: true, metric: 'pool_blocks_found_total',
    description: 'Submitted block was accepted by the network.' },
  BLOCK_003: { code: 'BLOCK_003', name: 'Block rejected by network', category: 'block', severity: 'error',
    persist: true, metric: 'pool_blocks_rejected_total',
    description: 'Submitted block was rejected by the daemon.' },
  BLOCK_004: { code: 'BLOCK_004', name: 'Block orphaned', category: 'block', severity: 'error',
    persist: true, metric: 'pool_blocks_orphaned_total',
    description: 'A previously accepted block was orphaned after confirmation checks.' },
  BLOCK_005: { code: 'BLOCK_005', name: 'New job broadcast', category: 'block', severity: 'info',
    persist: false, metric: 'pool_jobs_broadcast_total',
    description: 'A new mining job was broadcast to connected miners.' },
  BLOCK_006: { code: 'BLOCK_006', name: 'Job stale (superseded)', category: 'block', severity: 'info',
    persist: false, metric: 'pool_jobs_stale_total',
    description: 'A previous job was superseded by a newer template.' },

  // ─── AUXPOW ──────────────────────────────────────────────────────────────
  AUX_001: { code: 'AUX_001', name: 'AuxPoW merkle computed', category: 'auxpow', severity: 'info',
    persist: false, metric: 'pool_auxpow_merkle_computed_total',
    description: 'AuxPoW merkle tree rebuilt for the current job.' },
  AUX_002: { code: 'AUX_002', name: 'Aux chain block accepted', category: 'auxpow', severity: 'info',
    persist: true, metric: 'pool_aux_blocks_found_total',
    description: 'An auxiliary chain block was accepted by its network.' },
  AUX_003: { code: 'AUX_003', name: 'Aux chain block rejected', category: 'auxpow', severity: 'warn',
    persist: true, metric: 'pool_aux_blocks_rejected_total',
    description: 'An auxiliary chain block submission was rejected.' },
  AUX_004: { code: 'AUX_004', name: 'Aux merkle lock failed', category: 'auxpow', severity: 'error',
    persist: true, metric: 'pool_auxpow_lock_failures_total',
    description: 'Failed to acquire the distributed lock for aux submission.' },

  // ─── DAEMON ──────────────────────────────────────────────────────────────
  DAEMON_001: { code: 'DAEMON_001', name: 'Daemon connected', category: 'daemon', severity: 'info',
    persist: true, metric: 'pool_daemon_connections_total',
    description: 'RPC connection to a coin daemon established.' },
  DAEMON_002: { code: 'DAEMON_002', name: 'Daemon RPC timeout', category: 'daemon', severity: 'warn',
    persist: true, metric: 'pool_daemon_timeouts_total',
    description: 'An RPC call to a daemon exceeded its timeout.' },
  DAEMON_003: { code: 'DAEMON_003', name: 'Daemon connection lost', category: 'daemon', severity: 'error',
    persist: true, metric: 'pool_daemon_disconnections_total',
    description: 'Daemon RPC connection failed (socket error).' },
  DAEMON_004: { code: 'DAEMON_004', name: 'Daemon sync stalled', category: 'daemon', severity: 'warn',
    persist: true, metric: 'pool_daemon_stalls_total',
    description: 'Daemon height has not advanced within the expected window.' },
  DAEMON_005: { code: 'DAEMON_005', name: 'Daemon recovered', category: 'daemon', severity: 'info',
    persist: true, metric: 'pool_daemon_recoveries_total',
    description: 'Daemon RPC calls are succeeding again after a failure period.' },
  DAEMON_006: { code: 'DAEMON_006', name: 'Circuit breaker OPEN', category: 'daemon', severity: 'error',
    persist: true, metric: 'pool_circuit_breaker_open_total',
    description: 'Circuit breaker tripped to OPEN due to repeated RPC failures.' },
  DAEMON_007: { code: 'DAEMON_007', name: 'Circuit breaker CLOSED', category: 'daemon', severity: 'info',
    persist: true, metric: 'pool_circuit_breaker_close_total',
    description: 'Circuit breaker returned to CLOSED after successful probes.' },
  DAEMON_008: { code: 'DAEMON_008', name: 'getblocktemplate error', category: 'daemon', severity: 'error',
    persist: true, metric: 'pool_gbt_errors_total',
    description: 'getblocktemplate RPC returned an error.' },

  // ─── VARDIFF ─────────────────────────────────────────────────────────────
  VARDIFF_001: { code: 'VARDIFF_001', name: 'Difficulty adjusted UP', category: 'vardiff', severity: 'info',
    persist: false, metric: 'pool_vardiff_adjustments_up_total',
    description: 'VarDiff retargeted a miner to a higher difficulty.' },
  VARDIFF_002: { code: 'VARDIFF_002', name: 'Difficulty adjusted DOWN', category: 'vardiff', severity: 'info',
    persist: false, metric: 'pool_vardiff_adjustments_down_total',
    description: 'VarDiff retargeted a miner to a lower difficulty.' },
  VARDIFF_003: { code: 'VARDIFF_003', name: 'Hashrate estimated', category: 'vardiff', severity: 'info',
    persist: false, metric: 'pool_hashrate_estimates_total',
    description: 'A hashrate estimate was computed for a worker.' },
  VARDIFF_004: { code: 'VARDIFF_004', name: 'Vardiff at ceiling', category: 'vardiff', severity: 'warn',
    persist: false, metric: 'pool_vardiff_ceiling_hits_total',
    description: 'A miner has reached the configured vardiff ceiling.' },

  // ─── PAYMENT ─────────────────────────────────────────────────────────────
  PAY_001: { code: 'PAY_001', name: 'PPLNS window recalculated', category: 'payment', severity: 'info',
    persist: true, metric: 'pool_pplns_recalculations_total',
    description: 'The PPLNS share window was recomputed for a confirmed block.' },
  PAY_002: { code: 'PAY_002', name: 'Payment batch initiated', category: 'payment', severity: 'info',
    persist: true, metric: 'pool_payment_batches_total',
    description: 'A payment batch has started processing.' },
  PAY_003: { code: 'PAY_003', name: 'LTC payment sent', category: 'payment', severity: 'info',
    persist: true, metric: 'pool_payments_sent_total',
    description: 'A Litecoin payment transaction was broadcast successfully.' },
  PAY_004: { code: 'PAY_004', name: 'Aux payment sent', category: 'payment', severity: 'info',
    persist: true, metric: 'pool_aux_payments_sent_total',
    description: 'An auxiliary-chain payment transaction was broadcast successfully.' },
  PAY_005: { code: 'PAY_005', name: 'Payment failed', category: 'payment', severity: 'error',
    persist: true, metric: 'pool_payment_failures_total',
    description: 'A payment batch failed and will be retried.' },
  PAY_006: { code: 'PAY_006', name: 'Below payout threshold', category: 'payment', severity: 'info',
    persist: false, metric: 'pool_payout_skipped_threshold_total',
    description: 'A miner payout was skipped because it is below the threshold.' },

  // ─── SECURITY ────────────────────────────────────────────────────────────
  SEC_001: { code: 'SEC_001', name: 'Rate limit triggered', category: 'security', severity: 'warn',
    persist: true, metric: 'pool_rate_limit_hits_total',
    description: 'Rate-limit layer rejected or throttled a miner.' },
  SEC_002: { code: 'SEC_002', name: 'IP banned (auto)', category: 'security', severity: 'warn',
    persist: true, metric: 'pool_bans_total',
    description: 'A miner IP was auto-banned by the security engine.' },
  SEC_003: { code: 'SEC_003', name: 'Sybil detection triggered', category: 'security', severity: 'warn',
    persist: true, metric: 'pool_sybil_events_total',
    description: 'Sybil pattern (multiple addresses sharing an IP) was detected.' },
  SEC_004: { code: 'SEC_004', name: 'Suspicious share pattern', category: 'security', severity: 'error',
    persist: true, metric: 'pool_suspicious_share_events_total',
    description: 'Share fingerprint layer flagged a suspicious pattern (BWH/stale abuse).' },
  SEC_005: { code: 'SEC_005', name: 'Invalid miner address', category: 'security', severity: 'warn',
    persist: true, metric: 'pool_invalid_address_total',
    description: 'A worker attempted to authorize with an invalid payout address.' },
  SEC_006: { code: 'SEC_006', name: 'API abuse detected', category: 'security', severity: 'warn',
    persist: true, metric: 'pool_api_abuse_total',
    description: 'API rate-limit or abuse handler fired.' },

  // ─── SYSTEM ──────────────────────────────────────────────────────────────
  SYS_001: { code: 'SYS_001', name: 'Pool startup', category: 'system', severity: 'info',
    persist: true, metric: 'pool_startups_total',
    description: 'Pool finished initialization and is accepting miners.' },
  SYS_002: { code: 'SYS_002', name: 'Pool shutdown (clean)', category: 'system', severity: 'info',
    persist: true, metric: 'pool_shutdowns_total',
    description: 'Pool is shutting down cleanly.' },
  SYS_003: { code: 'SYS_003', name: 'PostgreSQL error', category: 'system', severity: 'error',
    persist: false, metric: 'pool_pg_errors_total',
    description: 'A PostgreSQL query or pool error occurred.' },
  SYS_004: { code: 'SYS_004', name: 'Redis error', category: 'system', severity: 'error',
    persist: true, metric: 'pool_redis_errors_total',
    description: 'Redis connection or command failed.' },
  SYS_005: { code: 'SYS_005', name: 'Redis reconnected', category: 'system', severity: 'info',
    persist: true, metric: 'pool_redis_reconnections_total',
    description: 'Redis connection was restored after a failure.' },
  SYS_006: { code: 'SYS_006', name: 'High memory usage', category: 'system', severity: 'warn',
    persist: true, metric: 'pool_memory_warnings_total',
    description: 'Process RSS exceeded the configured warning threshold.' },
  SYS_007: { code: 'SYS_007', name: 'Disk space warning', category: 'system', severity: 'warn',
    persist: true, metric: 'pool_disk_warnings_total',
    description: 'Free disk space fell below the configured threshold.' },
  SYS_008: { code: 'SYS_008', name: 'API 500 error', category: 'system', severity: 'error',
    persist: true, metric: 'pool_api_500_errors_total',
    description: 'An unhandled error was thrown by an API route.' },
  SYS_009: { code: 'SYS_009', name: 'Prometheus metrics scraped', category: 'system', severity: 'info',
    persist: false, metric: 'pool_prometheus_scrapes_total',
    description: 'The /metrics endpoint was scraped.' },
});

function getEvent(code) {
  return EVENTS[code];
}

function getByCategory(category) {
  return Object.values(EVENTS).filter(ev => ev.category === category);
}

function getBySeverity(severity) {
  return Object.values(EVENTS).filter(ev => ev.severity === severity);
}

module.exports = { EVENTS, getEvent, getByCategory, getBySeverity };
