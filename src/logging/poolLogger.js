'use strict';

/**
 * LUXXPOOL v0.8.2 — Pool Logger
 *
 * The single entry point for every observable event in the pool.
 * One call to logger.emit(code, data) fans out to:
 *   1. Pino structured stdout (always, severity-mapped)
 *   2. PostgreSQL pool_events table (if event.persist && pg wired)
 *   3. Prometheus counter (if metrics wired)
 *   4. Alert delivery — email/telegram/webhook (warn/error/critical only)
 *   5. Internal EventEmitter bus (for WebSocket + internal consumers)
 *
 * All side effects are non-blocking and non-throwing. A failure in any
 * delivery channel is logged to stdout but never propagates to the caller.
 *
 * Exports a singleton. `index.js` wires pg + metrics once at startup.
 */

const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');
const { EVENTS, getEvent } = require('./eventCodes');
const alertDelivery = require('./alertDelivery');

class PoolLogger {
  constructor() {
    this.log = createLogger('pool');
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(50);
    this._pg = null;
    this._metrics = null;
  }

  /** Called once from src/index.js after the pg Pool is initialized. */
  setPg(pgPool) { this._pg = pgPool; }

  /** Called once from src/index.js after metricsExporter is required. */
  setMetrics(exporter) { this._metrics = exporter; }

  /**
   * Emit an event.
   * @param {string} code   — event code from eventCodes.js (e.g. 'SHARE_001')
   * @param {object} [data] — event metadata (address, worker, chain, etc.)
   */
  emit(code, data = {}) {
    const ev = getEvent(code);
    if (!ev) {
      this.log.warn({ code }, 'poolLogger: unknown event code');
      return;
    }

    const payload = {
      ts: Date.now(),
      event: code,
      name: ev.name,
      category: ev.category,
      severity: ev.severity,
      chain: data.chain || 'LTC',
      data,
    };

    // 1. Pino stdout — always
    const pinoLevel = ev.severity === 'critical' ? 'error' : ev.severity;
    try {
      this.log[pinoLevel]({ ev: code, chain: payload.chain, ...data }, ev.name);
    } catch (_) { /* never throw */ }

    // 2. Prometheus counter — always (if wired)
    if (this._metrics) {
      try {
        this._metrics.increment(ev.metric, {
          category: ev.category,
          severity: ev.severity,
          chain: payload.chain,
        });
      } catch (err) {
        this.log.warn({ err: err.message, code }, 'metrics increment failed');
      }
    }

    // 3. PostgreSQL persistence — only if persist && pg wired (fire and forget)
    if (ev.persist && this._pg) {
      this._persistToDb(payload).catch(err => {
        this.log.error({ err: err.message, code }, 'pool_events insert failed');
      });
    }

    // 4. Alert delivery — warn/error/critical only (fire and forget)
    if (ev.severity !== 'info') {
      alertDelivery.send(payload).catch(() => { /* never throw */ });
    }

    // 5. WebSocket bus — always
    try {
      this.bus.emit('pool_event', payload);
      this.bus.emit(ev.category, payload);
    } catch (_) { /* never throw */ }
  }

  async _persistToDb(p) {
    const d = p.data || {};
    await this._pg.query(
      `INSERT INTO pool_events
         (code, category, severity, chain, address, worker, diff,
          block_height, txid, error_msg, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        p.event,
        p.category,
        p.severity,
        p.chain,
        d.address || null,
        d.worker || null,
        d.diff || d.difficulty || null,
        d.height || d.block_height || null,
        d.txid || null,
        d.error || d.reason || null,
        JSON.stringify(d),
      ]
    );
  }

  // ─── Convenience wrappers (thin — all call emit) ─────────────────────────

  get share() {
    return {
      accepted: (address, worker, diff, jobId) =>
        this.emit('SHARE_001', { address, worker, diff, jobId }),
      stale: (address, worker, jobId) =>
        this.emit('SHARE_002', { address, worker, jobId }),
      lowDiff: (address, worker, submittedDiff, requiredDiff) =>
        this.emit('SHARE_003', { address, worker, submittedDiff, requiredDiff }),
      duplicate: (address, worker, nonce) =>
        this.emit('SHARE_004', { address, worker, nonce }),
      invalid: (address, worker, reason) =>
        this.emit('SHARE_005', { address, worker, reason }),
    };
  }

  get block() {
    return {
      submitted: (height, hash, chain = 'LTC') =>
        this.emit('BLOCK_001', { height, hash, chain }),
      accepted: (height, hash, reward, chain = 'LTC') =>
        this.emit('BLOCK_002', { height, hash, reward, chain }),
      rejected: (height, hash, reason, chain = 'LTC') =>
        this.emit('BLOCK_003', { height, hash, reason, chain }),
      orphaned: (height, hash, chain = 'LTC') =>
        this.emit('BLOCK_004', { height, hash, chain }),
    };
  }

  get daemon() {
    return {
      connected: (chain) => this.emit('DAEMON_001', { chain }),
      timeout: (chain, rpc) => this.emit('DAEMON_002', { chain, rpc }),
      lost: (chain, error) => this.emit('DAEMON_003', { chain, error: error?.message || error }),
      stalled: (chain, lastHeight, stalledFor) =>
        this.emit('DAEMON_004', { chain, lastHeight, stalledFor }),
      recovered: (chain) => this.emit('DAEMON_005', { chain }),
      circuitOpen: (chain, failures) => this.emit('DAEMON_006', { chain, failures }),
      circuitClosed: (chain) => this.emit('DAEMON_007', { chain }),
    };
  }

  get system() {
    return {
      startup: (meta = {}) => this.emit('SYS_001', meta),
      shutdown: (reason) => this.emit('SYS_002', { reason }),
      pgError: (error) => this.emit('SYS_003', { error: error?.message || error }),
      redisError: (error) => this.emit('SYS_004', { error: error?.message || error }),
      redisReconnected: () => this.emit('SYS_005', {}),
      highMemory: (usedMb, totalMb) => this.emit('SYS_006', { usedMb, totalMb }),
      diskWarning: (path, usedPct) => this.emit('SYS_007', { path, usedPct }),
      api500: (route, error) => this.emit('SYS_008', { route, error: error?.message || error }),
    };
  }
}

module.exports = new PoolLogger();
