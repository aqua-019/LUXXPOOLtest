/**
 * LUXXPOOL — Worker Tracker
 * Granular per-worker statistics, pool-hopping detection,
 * stale share rate monitoring, and automatic difficulty floor.
 */

const { createLogger } = require('../utils/logger');
const HashrateEstimator = require('./hashrateEstimator');

const log = createLogger('workers');

class WorkerTracker {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
    this.workers = new Map(); // workerId → WorkerProfile
    this.timer = null;
  }

  start() {
    // Persist worker stats every 60s
    this.timer = setInterval(() => this._persistAll(), 60000);
    log.info('Worker tracker started');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Register or update a worker on connect
   */
  onConnect(client, userAgent) {
    const key = client.id;

    this.workers.set(key, {
      clientId: client.id,
      workerName: client.workerName,
      minerAddress: client.minerAddress,
      workerTag: client.workerTag,
      ip: client.remoteAddress,
      userAgent,
      connectedAt: Date.now(),
      lastShareAt: null,

      // v0.7.0: Miner model detection
      minerModel: client._minerModel?.name || null,
      minerModelKey: client._minerModel?.key || null,
      firmwareVersion: client._firmwareVersion || null,

      // Share accounting
      validShares: 0,
      invalidShares: 0,
      staleShares: 0,
      totalDifficulty: 0,
      blocksFound: 0,

      // Pool-hop detection
      sessionDuration: 0,
      disconnects: 0,
      shortSessions: 0, // sessions < 10 minutes
    });
  }

  /**
   * Record a valid share
   */
  onValidShare(client, difficulty) {
    const w = this.workers.get(client.id);
    if (!w) return;

    w.validShares++;
    w.totalDifficulty += difficulty;
    w.lastShareAt = Date.now();
  }

  /**
   * Record an invalid share
   */
  onInvalidShare(client) {
    const w = this.workers.get(client.id);
    if (w) w.invalidShares++;
  }

  /**
   * Record a stale share
   */
  onStaleShare(client) {
    const w = this.workers.get(client.id);
    if (w) w.staleShares++;
  }

  /**
   * Record a block found by this worker
   */
  onBlockFound(client) {
    const w = this.workers.get(client.id);
    if (w) w.blocksFound++;
  }

  /**
   * Handle disconnect — detect pool hopping
   */
  onDisconnect(client) {
    const w = this.workers.get(client.id);
    if (!w) return;

    w.sessionDuration = Date.now() - w.connectedAt;

    // Pool-hopping indicator: session < 10 minutes with shares submitted
    if (w.sessionDuration < 600000 && w.validShares > 0) {
      w.shortSessions++;

      if (w.shortSessions >= 3) {
        log.warn({
          worker: w.workerName,
          address: w.minerAddress,
          sessions: w.shortSessions,
          avgSession: Math.round(w.sessionDuration / 1000) + 's',
        }, '⚠️  Pool-hopping detected');
      }
    }

    // Persist before removing
    this._persistWorker(w);
    this.workers.delete(client.id);
  }

  /**
   * Get worker stats for API
   */
  getWorkerStats(clientId) {
    const w = this.workers.get(clientId);
    if (!w) return null;

    const totalShares = w.validShares + w.invalidShares + w.staleShares;
    return {
      ...w,
      rejectRate: totalShares > 0 ? ((w.invalidShares + w.staleShares) / totalShares * 100).toFixed(2) + '%' : '0%',
      sessionDuration: Date.now() - w.connectedAt,
    };
  }

  /**
   * Get all active worker summaries
   */
  getAllWorkers() {
    return Array.from(this.workers.values()).map(w => ({
      workerName: w.workerName,
      minerAddress: w.minerAddress,
      ip: w.ip,
      validShares: w.validShares,
      invalidShares: w.invalidShares,
      staleShares: w.staleShares,
      totalDifficulty: w.totalDifficulty,
      connectedAt: w.connectedAt,
      lastShareAt: w.lastShareAt,
      sessionMs: Date.now() - w.connectedAt,
    }));
  }

  /**
   * Get stale share rate across the pool
   */
  /**
   * v0.7.0: Get model distribution for dashboard.
   */
  getModelDistribution() {
    const distribution = {};
    for (const [, w] of this.workers) {
      const model = w.minerModel || 'Unknown';
      if (!distribution[model]) {
        distribution[model] = { count: 0, totalHashrate: 0 };
      }
      distribution[model].count++;
      distribution[model].totalHashrate += w.totalDifficulty;
    }
    return distribution;
  }

  getPoolStaleRate() {
    let totalValid = 0, totalStale = 0;
    for (const [, w] of this.workers) {
      totalValid += w.validShares;
      totalStale += w.staleShares;
    }
    const total = totalValid + totalStale;
    return total > 0 ? (totalStale / total * 100) : 0;
  }

  /**
   * Calculate recommended difficulty floor based on pool hashrate
   * Goal: ~15 shares per second per miner at optimal diff
   */
  calculateDifficultyFloor(poolHashrate, minerCount) {
    if (minerCount === 0 || poolHashrate === 0) return 64;

    const avgHashPerMiner = poolHashrate / minerCount;
    // target: 1 share every 15 seconds
    // diff = hashrate * targetTime / 2^32
    const idealDiff = (avgHashPerMiner * 15) / 4294967296;

    // Snap to power of 2 and enforce minimum
    const pow2 = Math.pow(2, Math.round(Math.log2(Math.max(idealDiff, 64))));
    return Math.max(64, Math.min(65536, pow2));
  }

  async _persistWorker(w) {
    if (!this.db) return;
    try {
      await this.db.query(
        `INSERT INTO workers (miner_id, name, full_name, hashrate, last_share, is_online, ip_address, user_agent)
         SELECT m.id, $2, $3, $4, NOW(), false, $5, $6
         FROM miners m WHERE m.address = $1
         ON CONFLICT (full_name) DO UPDATE SET
           hashrate = $4, last_share = NOW(), is_online = false`,
        [w.minerAddress, w.workerTag, w.workerName, w.totalDifficulty, w.ip, w.userAgent]
      );
    } catch (err) { log.debug({ err: err.message }, 'Worker persist failed'); }
  }

  async _persistAll() {
    const now = Date.now();
    const IDLE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

    for (const [id, w] of this.workers) {
      // Prune workers idle for over 1 hour with no recent shares
      if (w.lastShareAt && (now - w.lastShareAt) > IDLE_THRESHOLD_MS) {
        log.info({ worker: w.workerName, idleMs: now - w.lastShareAt }, 'Pruning idle worker');
        this._persistWorker(w);
        this.workers.delete(id);
        continue;
      }

      if (!this.db) continue;
      try {
        await this.db.query(
          `INSERT INTO workers (miner_id, name, full_name, hashrate, last_share, is_online, ip_address, user_agent)
           SELECT m.id, $2, $3, $4, NOW(), true, $5, $6
           FROM miners m WHERE m.address = $1
           ON CONFLICT (full_name) DO UPDATE SET
             hashrate = $4, last_share = NOW(), is_online = true`,
          [w.minerAddress, w.workerTag, w.workerName, w.totalDifficulty, w.ip, w.userAgent]
        );
      } catch (err) { log.debug({ err: err.message }, 'Worker batch persist failed'); }
    }
  }
}

module.exports = WorkerTracker;
