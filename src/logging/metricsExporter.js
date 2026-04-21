'use strict';

/**
 * LUXXPOOL v0.8.2 — Prometheus Metrics Exporter
 *
 * Auto-registers one Counter per unique event metric name from eventCodes.js,
 * plus gauges for current pool state and histograms for latency distributions.
 *
 * Public API:
 *   increment(metricName, labels)   — bump a counter
 *   setGauge(name, value, labels)
 *   observe(name, value, labels)
 *   metricsRoute(req, res)          — Express handler for GET /metrics
 *   recordShare(status)             — back-compat shim for src/index.js
 *   recordBlock(chain, kind)        — back-compat shim for src/index.js
 *   register                         — underlying prom-client Registry
 *   gauges, histograms              — direct access to registered objects
 */

const client = require('prom-client');
const { EVENTS } = require('./eventCodes');

const register = new client.Registry();

// Default Node.js metrics (CPU, memory, GC, event-loop lag, etc.)
client.collectDefaultMetrics({ register, prefix: 'pool_node_' });

// ─── Counters — one per unique event metric ────────────────────────────────
const counters = new Map();
for (const ev of Object.values(EVENTS)) {
  if (counters.has(ev.metric)) continue;
  const counter = new client.Counter({
    name: ev.metric,
    help: ev.description || ev.name,
    labelNames: ['category', 'severity', 'chain'],
    registers: [register],
  });
  counters.set(ev.metric, counter);
}

// ─── Gauges ────────────────────────────────────────────────────────────────
const gauges = {
  connectedMiners: new client.Gauge({
    name: 'pool_connected_miners', help: 'Currently connected miners',
    labelNames: ['chain'], registers: [register] }),
  hashrateMhs: new client.Gauge({
    name: 'pool_hashrate_mhs', help: 'Pool hashrate in MH/s',
    labelNames: ['chain'], registers: [register] }),
  networkDifficultyLtc: new client.Gauge({
    name: 'pool_network_difficulty_ltc', help: 'Current LTC network difficulty',
    registers: [register] }),
  pendingPayoutLtc: new client.Gauge({
    name: 'pool_pending_payout_ltc', help: 'Pending LTC payouts across all miners',
    registers: [register] }),
  daemonBlockHeight: new client.Gauge({
    name: 'pool_daemon_block_height', help: 'Current daemon block height',
    labelNames: ['chain'], registers: [register] }),
  daemonSynced: new client.Gauge({
    name: 'pool_daemon_synced', help: 'Daemon sync state (1=synced, 0=syncing)',
    labelNames: ['chain'], registers: [register] }),
  circuitBreakerState: new client.Gauge({
    name: 'pool_circuit_breaker_state', help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
    labelNames: ['chain'], registers: [register] }),
  shareAcceptRate: new client.Gauge({
    name: 'pool_share_accept_rate', help: 'Rolling share accept rate (0.0–1.0)',
    registers: [register] }),
  pplnsWindowShares: new client.Gauge({
    name: 'pool_pplns_window_shares', help: 'Total shares in current PPLNS window',
    registers: [register] }),
  lastBlockFoundTimestamp: new client.Gauge({
    name: 'pool_last_block_found_timestamp', help: 'Unix timestamp of last block found',
    labelNames: ['chain'], registers: [register] }),
};

// ─── Histograms ────────────────────────────────────────────────────────────
const histograms = {
  shareValidationDurationMs: new client.Histogram({
    name: 'pool_share_validation_duration_ms', help: 'Share validation latency',
    buckets: [0.5, 1, 2, 5, 10, 25, 50], registers: [register] }),
  rpcLatencyMs: new client.Histogram({
    name: 'pool_rpc_latency_ms', help: 'RPC call latency',
    labelNames: ['chain', 'method'],
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000], registers: [register] }),
  paymentBatchDurationMs: new client.Histogram({
    name: 'pool_payment_batch_duration_ms', help: 'Payment batch execution duration',
    buckets: [100, 250, 500, 1000, 2500, 5000], registers: [register] }),
};

// ─── Public API ────────────────────────────────────────────────────────────

function increment(metricName, labels = {}) {
  const c = counters.get(metricName);
  if (!c) return;
  const safeLabels = {
    category: labels.category || 'unknown',
    severity: labels.severity || 'info',
    chain: labels.chain || 'LTC',
  };
  c.inc(safeLabels);
}

function setGauge(name, value, labels = {}) {
  const g = gauges[name];
  if (!g) return;
  if (Object.keys(labels).length) g.set(labels, value);
  else g.set(value);
}

function observe(name, value, labels = {}) {
  const h = histograms[name];
  if (!h) return;
  if (Object.keys(labels).length) h.observe(labels, value);
  else h.observe(value);
}

// Back-compat shim for existing calls in src/index.js (lines 573, 618, 630, 638, 649).
// Maps legacy `prom.recordShare(status)` / `prom.recordBlock(chain, kind)` to the
// new per-event counters.
const SHARE_STATUS_METRIC = {
  valid:     'pool_shares_accepted_total',
  rejected:  'pool_shares_invalid_total',
  stale:     'pool_shares_stale_total',
  duplicate: 'pool_shares_duplicate_total',
  lowdiff:   'pool_shares_low_diff_total',
};

function recordShare(status, chain = 'LTC') {
  const metric = SHARE_STATUS_METRIC[status];
  if (!metric) return;
  increment(metric, { category: 'share', severity: status === 'valid' ? 'info' : 'warn', chain });
}

function recordBlock(chain = 'LTC', _kind = 'parent') {
  increment('pool_blocks_found_total', { category: 'block', severity: 'info', chain });
}

async function metricsRoute(_req, res) {
  try {
    increment('pool_prometheus_scrapes_total', { category: 'system', severity: 'info', chain: 'LTC' });
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
}

module.exports = {
  increment,
  setGauge,
  observe,
  metricsRoute,
  recordShare,
  recordBlock,
  register,
  gauges,
  histograms,
  counters,
};
