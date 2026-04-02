/**
 * LUXXPOOL — Prometheus Metrics Exporter
 * Exposes pool metrics in Prometheus format at /metrics
 */

const promClient = require('prom-client');
const { createLogger } = require('../utils/logger');

const log = createLogger('prometheus');

// Default labels
promClient.register.setDefaultLabels({ pool: 'luxxpool' });

// Collect default Node.js process metrics (memory, CPU, GC, event loop)
promClient.collectDefaultMetrics({ prefix: 'luxxpool_' });

// ═══════════════════════════════════════════════════════
// POOL GAUGES
// ═══════════════════════════════════════════════════════

const poolHashrate = new promClient.Gauge({
  name: 'luxxpool_hashrate_hps',
  help: 'Pool hashrate in H/s',
});

const activeMiners = new promClient.Gauge({
  name: 'luxxpool_active_miners',
  help: 'Number of connected authorized miners',
});

const activeWorkers = new promClient.Gauge({
  name: 'luxxpool_active_workers',
  help: 'Number of connected stratum clients',
});

const lockdownLevel = new promClient.Gauge({
  name: 'luxxpool_lockdown_level',
  help: 'Emergency lockdown level (0=normal, 3=maintenance)',
});

// ═══════════════════════════════════════════════════════
// COUNTERS
// ═══════════════════════════════════════════════════════

const sharesTotal = new promClient.Counter({
  name: 'luxxpool_shares_total',
  help: 'Total shares processed',
  labelNames: ['status'], // valid, rejected, stale, duplicate
});

const blocksFound = new promClient.Counter({
  name: 'luxxpool_blocks_found_total',
  help: 'Total blocks found',
  labelNames: ['coin', 'type'], // type: parent, aux
});

const paymentsTotal = new promClient.Counter({
  name: 'luxxpool_payments_total',
  help: 'Total payments sent',
  labelNames: ['coin'],
});

const connectionsTotal = new promClient.Counter({
  name: 'luxxpool_connections_total',
  help: 'Total stratum connections',
  labelNames: ['port'], // pool, ssl, solo
});

// ═══════════════════════════════════════════════════════
// HISTOGRAMS
// ═══════════════════════════════════════════════════════

const shareProcessingTime = new promClient.Histogram({
  name: 'luxxpool_share_processing_seconds',
  help: 'Time to validate a share (seconds)',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

// ═══════════════════════════════════════════════════════
// WIRING HELPERS
// ═══════════════════════════════════════════════════════

function updateGauges({ hashrate, miners, workers, lockdown } = {}) {
  if (hashrate !== undefined) poolHashrate.set(hashrate);
  if (miners !== undefined) activeMiners.set(miners);
  if (workers !== undefined) activeWorkers.set(workers);
  if (lockdown !== undefined) lockdownLevel.set(lockdown);
}

function recordShare(status) {
  sharesTotal.inc({ status });
}

function recordBlock(coin, type = 'parent') {
  blocksFound.inc({ coin, type });
}

function recordPayment(coin) {
  paymentsTotal.inc({ coin });
}

function recordConnection(port) {
  connectionsTotal.inc({ port });
}

function observeShareTime(seconds) {
  shareProcessingTime.observe(seconds);
}

/**
 * Register the /metrics endpoint on an Express app
 */
function registerMetricsEndpoint(app) {
  app.get('/metrics', async (req, res) => {
    try {
      res.set('Content-Type', promClient.register.contentType);
      res.end(await promClient.register.metrics());
    } catch (err) {
      log.error({ err: err.message }, 'Metrics endpoint error');
      res.status(500).end();
    }
  });
  log.info('Prometheus /metrics endpoint registered');
}

module.exports = {
  updateGauges,
  recordShare,
  recordBlock,
  recordPayment,
  recordConnection,
  observeShareTime,
  registerMetricsEndpoint,
};
