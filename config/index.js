/**
 * LUXXPOOL — Configuration Module
 * Loads environment variables and provides typed, validated config
 */

require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'development',

  pool: {
    name:       process.env.POOL_NAME || 'LUXXPOOL',
    host:       process.env.POOL_HOST || 'luxxpool.io',
    fee:        parseFloat(process.env.POOL_FEE || '0.02'),
    feeAddress: process.env.POOL_FEE_ADDRESS,
  },

  stratum: {
    host: process.env.STRATUM_HOST || '0.0.0.0',
    port: parseInt(process.env.STRATUM_PORT || '3333'),
    portSsl: parseInt(process.env.STRATUM_PORT_SSL || '3334'),
    portSolo: parseInt(process.env.STRATUM_PORT_SOLO || '3336'),
    difficulty: parseInt(process.env.STRATUM_DIFFICULTY || '512'),
    vardiff: {
      min:          parseInt(process.env.STRATUM_VARDIFF_MIN || '64'),
      max:          parseInt(process.env.STRATUM_VARDIFF_MAX || '65536'),
      targetTime:   parseInt(process.env.STRATUM_VARDIFF_TARGET_TIME || '15'),
      retargetTime: parseInt(process.env.STRATUM_VARDIFF_RETARGET_TIME || '90'),
    },
    banning: {
      enabled:        process.env.STRATUM_BAN_ENABLED === 'true',
      time:           parseInt(process.env.STRATUM_BAN_TIME || '600'),
      invalidPercent: parseInt(process.env.STRATUM_BAN_INVALID_PERCENT || '50'),
    },
  },

  litecoin: {
    host:     process.env.LTC_HOST || '127.0.0.1',
    port:     parseInt(process.env.LTC_PORT || '9332'),
    user:     process.env.LTC_USER || 'luxxpool_rpc',
    password: process.env.LTC_PASS || '',
    zmqBlock: process.env.LTC_ZMQBLOCK || 'tcp://127.0.0.1:28332',
    zmqTx:    process.env.LTC_ZMQTX || 'tcp://127.0.0.1:28333',
  },

  dogecoin: {
    host:         process.env.DOGE_HOST || '127.0.0.1',
    port:         parseInt(process.env.DOGE_PORT || '22555'),
    user:         process.env.DOGE_USER || 'luxxpool_rpc',
    password:     process.env.DOGE_PASS || '',
    mergedMining: process.env.DOGE_MERGED_MINING === 'true',
  },

  postgres: {
    host:     process.env.PG_HOST || '127.0.0.1',
    port:     parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'luxxpool',
    user:     process.env.PG_USER || 'luxxpool',
    password: process.env.PG_PASS || '',
    poolSize: parseInt(process.env.PG_POOL_SIZE || '20'),
  },

  redis: {
    host:      process.env.REDIS_HOST || '127.0.0.1',
    port:      parseInt(process.env.REDIS_PORT || '6379'),
    password:  process.env.REDIS_PASSWORD || undefined,
    db:        parseInt(process.env.REDIS_DB || '0'),
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'lux:',
  },

  payment: {
    enabled:   process.env.PAYMENT_ENABLED === 'true',
    interval:  parseInt(process.env.PAYMENT_INTERVAL || '600'),
    minPayout: parseFloat(process.env.PAYMENT_MIN_PAYOUT || '0.01'),
    maxBatch:  parseInt(process.env.PAYMENT_MAX_BATCH || '100'),
    txFee:     parseFloat(process.env.PAYMENT_TX_FEE || '0.001'),
    scheme:    process.env.PAYMENT_SCHEME || 'pplns',
    pplnsWindow: parseInt(process.env.PPLNS_WINDOW || '10'),
  },

  api: {
    host:           process.env.API_HOST || '0.0.0.0',
    port:           parseInt(process.env.API_PORT || '8080'),
    corsOrigin:     process.env.API_CORS_ORIGIN || 'http://localhost:3000',
    adminToken:     process.env.API_ADMIN_TOKEN || null,
    rateLimitWindow: parseInt(process.env.API_RATE_LIMIT_WINDOW || '900000'),
    rateLimitMax:   parseInt(process.env.API_RATE_LIMIT_MAX || '100'),
  },

  monitoring: {
    enabled:  process.env.METRICS_ENABLED === 'true',
    port:     parseInt(process.env.METRICS_PORT || '9100'),
    logLevel: process.env.LOG_LEVEL || 'info',
    logFile:  process.env.LOG_FILE || '/var/log/luxxpool/pool.log',
  },

  security: {
    maxConnectionsPerIp: parseInt(process.env.DDOS_MAX_CONNECTIONS_PER_IP || '5'),
    banDuration:         parseInt(process.env.DDOS_BAN_DURATION || '3600'),
    sslCert:             process.env.SSL_CERT_PATH,
    sslKey:              process.env.SSL_KEY_PATH,
  },

  // v0.7.0: WebSocket configuration
  websocket: {
    maxConnections:          parseInt(process.env.WS_MAX_CONNECTIONS || '500'),
    heartbeatIntervalMs:     parseInt(process.env.WS_HEARTBEAT_MS || '30000'),
    poolBroadcastIntervalMs: parseInt(process.env.WS_POOL_BROADCAST_MS || '10000'),
    minerBroadcastIntervalMs: parseInt(process.env.WS_MINER_BROADCAST_MS || '30000'),
  },

  // v0.7.0: IP Reputation system
  ipReputation: {
    rejectThreshold: parseInt(process.env.IP_REPUTATION_REJECT || '10'),
    decayRate:       parseFloat(process.env.IP_REPUTATION_DECAY_RATE || '1'),
    persistIntervalMs: parseInt(process.env.IP_REPUTATION_PERSIST_MS || '300000'),
  },

  // v0.7.0: Emergency lockdown
  emergencyLockdown: {
    autoEscalation:    process.env.LOCKDOWN_AUTO_ESCALATION !== 'false',
    deescalationMinutes: parseInt(process.env.LOCKDOWN_DEESCALATION_MIN || '15'),
    rejectedThreshold: parseInt(process.env.LOCKDOWN_REJECTED_THRESHOLD || '100'),
    invalidThreshold:  parseInt(process.env.LOCKDOWN_INVALID_THRESHOLD || '1000'),
    bwhThreshold:      parseInt(process.env.LOCKDOWN_BWH_THRESHOLD || '3'),
    alertThreshold:    parseInt(process.env.LOCKDOWN_ALERT_THRESHOLD || '50'),
  },

  // v0.7.0: Audit logging
  auditLog: {
    retentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS || '90'),
    flushIntervalMs: parseInt(process.env.AUDIT_FLUSH_MS || '10000'),
    batchSize: parseInt(process.env.AUDIT_BATCH_SIZE || '50'),
  },

  // v0.7.0: Connection fingerprinting
  fingerprint: {
    clusterThreshold: parseInt(process.env.FINGERPRINT_CLUSTER_THRESHOLD || '5'),
    minSharesForPrint: parseInt(process.env.FINGERPRINT_MIN_SHARES || '10'),
  },
};

/**
 * Validate critical configuration
 */
function validateConfig() {
  const errors = [];

  if (!config.pool.feeAddress && config.pool.fee > 0) {
    errors.push('POOL_FEE_ADDRESS required when POOL_FEE > 0');
  }
  if (!config.litecoin.password) {
    errors.push('LTC_PASS (Litecoin RPC password) is required');
  }
  if (!config.postgres.password) {
    errors.push('PG_PASS (PostgreSQL password) is required');
  }
  if (config.pool.fee < 0 || config.pool.fee > 0.10) {
    errors.push('POOL_FEE must be between 0 and 0.10 (0-10%)');
  }

  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach(e => console.error(`  ✗ ${e}`));
    if (config.env === 'production') {
      process.exit(1);
    }
  }

  return errors.length === 0;
}

config.validate = validateConfig;

module.exports = config;
