/**
 * LUXXPOOL — Hashrate Estimator
 * Calculates hashrate from share submission rate and difficulty.
 *
 * Formula: hashrate = (shares × difficulty × 2^32) / time_window
 *
 * For Scrypt coins, difficulty 1 = 2^32 hashes.
 * So if a miner submits shares at difficulty D every T seconds:
 *   hashrate = D × 2^32 / T  (in H/s)
 */

const { createLogger } = require('../utils/logger');

const log = createLogger('hashrate');

// 2^32 = 4294967296
const DIFF1_HASHES = 4294967296;

class HashrateEstimator {
  /**
   * @param {object} opts
   * @param {number} opts.windowMs - Estimation window in ms (default 10 min)
   * @param {number} opts.updateIntervalMs - How often to recalculate (default 30s)
   */
  constructor(opts = {}) {
    this.windowMs = opts.windowMs || 600000;        // 10 minute window
    this.updateIntervalMs = opts.updateIntervalMs || 30000; // 30 second updates

    // Per-worker share records: workerId → [{ difficulty, timestamp }]
    this.shareRecords = new Map();

    // Cached hashrate results: workerId → { hashrate, updatedAt }
    this.cachedRates = new Map();

    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this._recalculateAll(), this.updateIntervalMs);
    log.info({ windowMs: this.windowMs }, 'Hashrate estimator started');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Record a valid share for hashrate estimation
   * @param {string} workerId - Unique worker identifier (clientId or workerName)
   * @param {number} difficulty - Share difficulty
   * @param {string} minerAddress - Miner's payout address
   */
  recordShare(workerId, difficulty, minerAddress) {
    if (!this.shareRecords.has(workerId)) {
      this.shareRecords.set(workerId, {
        shares: [],
        minerAddress,
      });
    }

    const record = this.shareRecords.get(workerId);
    record.shares.push({
      difficulty,
      timestamp: Date.now(),
    });

    // Prune old shares beyond 2x window
    const cutoff = Date.now() - (this.windowMs * 2);
    record.shares = record.shares.filter(s => s.timestamp > cutoff);
  }

  /**
   * Get estimated hashrate for a specific worker
   * @param {string} workerId
   * @returns {number} Hashrate in H/s
   */
  getWorkerHashrate(workerId) {
    const cached = this.cachedRates.get(workerId);
    if (cached) return cached.hashrate;
    return this._calculateHashrate(workerId);
  }

  /**
   * Get estimated hashrate for a miner address (all workers combined)
   * @param {string} minerAddress
   * @returns {number} Hashrate in H/s
   */
  getMinerHashrate(minerAddress) {
    let totalHashrate = 0;
    for (const [workerId, record] of this.shareRecords) {
      if (record.minerAddress === minerAddress) {
        totalHashrate += this.getWorkerHashrate(workerId);
      }
    }
    return totalHashrate;
  }

  /**
   * Get total pool hashrate
   * @returns {number} Total hashrate in H/s
   */
  getPoolHashrate() {
    let total = 0;
    for (const [workerId] of this.shareRecords) {
      total += this.getWorkerHashrate(workerId);
    }
    return total;
  }

  /**
   * Get hashrate formatted as human-readable string
   * @param {number} hashrate - H/s
   * @returns {string}
   */
  static formatHashrate(hashrate) {
    if (hashrate === 0) return '0 H/s';

    const units = [
      { suffix: 'EH/s', divisor: 1e18 },
      { suffix: 'PH/s', divisor: 1e15 },
      { suffix: 'TH/s', divisor: 1e12 },
      { suffix: 'GH/s', divisor: 1e9 },
      { suffix: 'MH/s', divisor: 1e6 },
      { suffix: 'KH/s', divisor: 1e3 },
      { suffix: 'H/s',  divisor: 1 },
    ];

    for (const unit of units) {
      if (hashrate >= unit.divisor) {
        return (hashrate / unit.divisor).toFixed(2) + ' ' + unit.suffix;
      }
    }
    return hashrate.toFixed(2) + ' H/s';
  }

  /**
   * Remove a worker (disconnected)
   */
  removeWorker(workerId) {
    this.shareRecords.delete(workerId);
    this.cachedRates.delete(workerId);
  }

  /**
   * v0.7.0: Get worker efficiency compared to expected hashrate.
   * @param {string} workerId
   * @param {number} expectedHashrate - Expected H/s from miner profile
   * @returns {{ actual, expected, efficiency }}
   */
  getWorkerEfficiency(workerId, expectedHashrate) {
    const actual = this.getWorkerHashrate(workerId);
    if (!expectedHashrate || expectedHashrate <= 0) {
      return { actual, expected: 0, efficiency: null };
    }
    return {
      actual,
      expected: expectedHashrate,
      efficiency: Math.round((actual / expectedHashrate) * 100) / 100,
    };
  }

  /**
   * v0.7.0: Get pool-wide efficiency metrics.
   * Requires worker model data to be set on share records.
   * @returns {{ totalActual, workerCount }}
   */
  getPoolEfficiencyMetrics() {
    let totalActual = 0;
    let workerCount = 0;

    for (const [workerId] of this.shareRecords) {
      const hr = this.getWorkerHashrate(workerId);
      if (hr > 0) {
        totalActual += hr;
        workerCount++;
      }
    }

    return { totalActual, workerCount };
  }

  // ═══════════════════════════════════════════════════════
  // INTERNAL
  // ═══════════════════════════════════════════════════════

  _calculateHashrate(workerId) {
    const record = this.shareRecords.get(workerId);
    if (!record || record.shares.length < 2) return 0;

    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Only consider shares within the window
    const windowShares = record.shares.filter(s => s.timestamp >= windowStart);
    if (windowShares.length === 0) return 0;

    // Sum total difficulty in window
    const totalDifficulty = windowShares.reduce((sum, s) => sum + s.difficulty, 0);

    // Time span: from first share in window to now
    const firstShareTime = windowShares[0].timestamp;
    const timeSpanSeconds = (now - firstShareTime) / 1000;

    if (timeSpanSeconds <= 0) return 0;

    // hashrate = (totalDifficulty × 2^32) / timeSpan
    const hashrate = (totalDifficulty * DIFF1_HASHES) / timeSpanSeconds;

    return hashrate;
  }

  _recalculateAll() {
    const now = Date.now();

    for (const [workerId] of this.shareRecords) {
      const hashrate = this._calculateHashrate(workerId);
      this.cachedRates.set(workerId, { hashrate, updatedAt: now });
    }

    // Clean up stale workers (no shares in 2x window)
    const staleThreshold = now - (this.windowMs * 2);
    for (const [workerId, record] of this.shareRecords) {
      const latestShare = record.shares[record.shares.length - 1];
      if (!latestShare || latestShare.timestamp < staleThreshold) {
        this.shareRecords.delete(workerId);
        this.cachedRates.delete(workerId);
      }
    }
  }
}

module.exports = HashrateEstimator;
