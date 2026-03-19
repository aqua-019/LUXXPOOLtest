/**
 * LUXXPOOL v0.4.0 — Daemon Health Monitor
 * Continuously monitors all blockchain daemon connectivity,
 * Redis, PostgreSQL, and system resources. Surfaces issues
 * before they cause mining disruptions.
 */

const EventEmitter = require('events');
const os = require('os');
const { createLogger } = require('../utils/logger');

const log = createLogger('health');

class DaemonHealthMonitor extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.rpcClients - { LTC: rpc, DOGE: rpc, ... }
   * @param {object} deps.redis
   * @param {object} deps.db
   * @param {number} intervalMs - Check interval (default 30s)
   */
  constructor(deps, intervalMs = 30000) {
    super();
    this.rpcClients = deps.rpcClients || {};
    this.redis = deps.redis;
    this.db = deps.db;
    this.intervalMs = intervalMs;
    this.timer = null;

    this.status = {
      daemons: {},
      redis: { connected: false, latencyMs: 0 },
      postgres: { connected: false, latencyMs: 0 },
      system: {},
      lastCheck: null,
    };
  }

  start() {
    log.info({ interval: this.intervalMs / 1000 }, 'Health monitor started');
    this._check();
    this.timer = setInterval(() => this._check(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async _check() {
    const start = Date.now();

    // Check each daemon
    for (const [symbol, rpc] of Object.entries(this.rpcClients)) {
      try {
        const dStart = Date.now();
        const info = await rpc.getBlockchainInfo();
        const latency = Date.now() - dStart;

        this.status.daemons[symbol] = {
          connected: true,
          latencyMs: latency,
          blocks: info.blocks,
          headers: info.headers,
          synced: info.blocks >= info.headers - 2,
          chain: info.chain,
          lastCheck: Date.now(),
        };

        // Alert if daemon is behind
        if (info.headers - info.blocks > 10) {
          log.warn({ coin: symbol, behind: info.headers - info.blocks }, 'Daemon syncing — behind tip');
          this.emit('daemonBehind', symbol, info.headers - info.blocks);
        }
      } catch (err) {
        const wasConnected = this.status.daemons[symbol]?.connected;
        this.status.daemons[symbol] = {
          connected: false,
          error: err.message,
          lastCheck: Date.now(),
        };

        if (wasConnected !== false) {
          log.error({ coin: symbol, err: err.message }, '❌ Daemon went offline!');
          this.emit('daemonDown', symbol, err.message);
        }
      }
    }

    // Check Redis
    try {
      const rStart = Date.now();
      await this.redis.ping();
      this.status.redis = { connected: true, latencyMs: Date.now() - rStart };
    } catch {
      if (this.status.redis.connected !== false) {
        log.error('❌ Redis went offline!');
        this.emit('redisDown');
      }
      this.status.redis = { connected: false, latencyMs: -1 };
    }

    // Check PostgreSQL
    try {
      const pStart = Date.now();
      await this.db.query('SELECT 1');
      this.status.postgres = { connected: true, latencyMs: Date.now() - pStart };
    } catch {
      if (this.status.postgres.connected !== false) {
        log.error('❌ PostgreSQL went offline!');
        this.emit('postgresDown');
      }
      this.status.postgres = { connected: false, latencyMs: -1 };
    }

    // System resources
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const loadAvg = os.loadavg();

    this.status.system = {
      memoryUsedPct: Math.round(((totalMem - freeMem) / totalMem) * 100),
      loadAvg1m: loadAvg[0],
      loadAvg5m: loadAvg[1],
      uptime: os.uptime(),
      cpuCount: os.cpus().length,
      nodeMemMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    };

    // Alert on high memory
    if (this.status.system.memoryUsedPct > 90) {
      log.warn({ memPct: this.status.system.memoryUsedPct }, '⚠️  High memory usage');
      this.emit('highMemory', this.status.system.memoryUsedPct);
    }

    this.status.lastCheck = Date.now();
    this.status.checkDurationMs = Date.now() - start;
  }

  /**
   * Get full health status (for API endpoint)
   */
  getStatus() {
    return this.status;
  }

  /**
   * Quick boolean: is the pool healthy enough to mine?
   */
  isHealthy() {
    const ltc = this.status.daemons.LTC;
    return ltc?.connected && ltc?.synced && this.status.postgres.connected;
  }
}

module.exports = DaemonHealthMonitor;
