/**
 * LUXXPOOL v0.7.0 — Hashrate Optimizer
 * Analyzes per-miner and pool-wide hashrate efficiency.
 * Detects underperforming miners, suggests difficulty tuning,
 * and provides model-level benchmarks for optimization.
 */

const { createLogger } = require('../utils/logger');
const HashrateEstimator = require('../monitoring/hashrateEstimator');

const log = createLogger('hashrate-optimizer');

// Efficiency thresholds
const UNDERPERFORMANCE_THRESHOLD = 0.80; // Below 80% = underperforming
const CRITICAL_THRESHOLD = 0.50;          // Below 50% = critical issue
const OVERPERFORMANCE_THRESHOLD = 1.20;   // Above 120% = possible overclock

class HashrateOptimizer {
  /**
   * @param {HashrateEstimator} hashrateEstimator
   * @param {object} minerRegistry - MinerRegistry instance
   * @param {object} workerTracker - WorkerTracker instance
   * @param {object} db - Database query interface
   */
  constructor(hashrateEstimator, minerRegistry, workerTracker, db) {
    this.hashrate = hashrateEstimator;
    this.registry = minerRegistry;
    this.workers = workerTracker;
    this.db = db;
    this.timer = null;

    // Model-level aggregate stats (updated every cycle)
    this.modelStats = new Map(); // modelKey → { totalActual, totalExpected, count, staleShares, totalShares }
  }

  start() {
    // Run optimization analysis every 5 minutes
    this.timer = setInterval(() => this._analyzeAll(), 300000);
    log.info('Hashrate optimizer started');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Analyze a specific worker's hashrate efficiency.
   * @param {string} workerId
   * @param {string} modelKey - Detected miner model
   * @returns {{ efficiency, status, recommendation, actualHashrate, expectedHashrate }}
   */
  analyzeWorker(workerId, modelKey) {
    const actualHashrate = this.hashrate.getWorkerHashrate(workerId);
    const expectedHashrate = this.registry.getExpectedHashrate(modelKey);

    if (!expectedHashrate || !actualHashrate) {
      return {
        efficiency: null,
        status: 'unknown',
        recommendation: null,
        actualHashrate,
        expectedHashrate,
      };
    }

    const efficiency = actualHashrate / expectedHashrate;
    let status, recommendation;

    if (efficiency < CRITICAL_THRESHOLD) {
      status = 'critical';
      recommendation = 'Miner operating below 50% expected hashrate. Check hardware, cooling, and power supply.';
    } else if (efficiency < UNDERPERFORMANCE_THRESHOLD) {
      status = 'underperforming';
      recommendation = 'Miner below 80% expected hashrate. Verify firmware, network latency, and difficulty settings.';
    } else if (efficiency > OVERPERFORMANCE_THRESHOLD) {
      status = 'overclocked';
      recommendation = 'Miner exceeding expected hashrate by 20%+. May be overclocked — monitor for hardware stability.';
    } else {
      status = 'optimal';
      recommendation = null;
    }

    return { efficiency: Math.round(efficiency * 100) / 100, status, recommendation, actualHashrate, expectedHashrate };
  }

  /**
   * Suggest optimal difficulty for a worker based on observed hashrate.
   * Uses the formula: optimalDiff = (hashrate × targetTime) / 2^32
   * @param {string} workerId
   * @param {number} targetTime - Target share interval in seconds (default 15)
   * @returns {number|null} Suggested difficulty, or null if insufficient data
   */
  suggestDifficulty(workerId, targetTime = 15) {
    const hashrate = this.hashrate.getWorkerHashrate(workerId);
    if (!hashrate || hashrate <= 0) return null;

    const DIFF1_HASHES = 4294967296; // 2^32
    const suggested = Math.round((hashrate * targetTime) / DIFF1_HASHES);

    // Snap to nearest power of 2
    const log2 = Math.log2(suggested);
    const lower = Math.pow(2, Math.floor(log2));
    const upper = Math.pow(2, Math.ceil(log2));
    return (suggested - lower < upper - suggested) ? lower : upper;
  }

  /**
   * Get model distribution across connected miners.
   * @returns {Array<{ model, modelKey, count, totalHashrate, avgEfficiency }>}
   */
  getModelDistribution() {
    const dist = new Map();

    if (!this.workers || !this.workers.workers) return [];

    for (const [, worker] of this.workers.workers) {
      const model = worker.minerModel || 'unknown';
      const modelKey = worker.modelKey || null;

      if (!dist.has(model)) {
        dist.set(model, {
          model,
          modelKey,
          count: 0,
          totalHashrate: 0,
          efficiencies: [],
        });
      }

      const entry = dist.get(model);
      entry.count++;

      const hr = this.hashrate.getWorkerHashrate(worker.clientId);
      if (hr) entry.totalHashrate += hr;

      if (modelKey) {
        const expected = this.registry.getExpectedHashrate(modelKey);
        if (expected && hr) {
          entry.efficiencies.push(hr / expected);
        }
      }
    }

    return Array.from(dist.values()).map(d => ({
      model: d.model,
      modelKey: d.modelKey,
      count: d.count,
      totalHashrate: d.totalHashrate,
      avgEfficiency: d.efficiencies.length > 0
        ? Math.round((d.efficiencies.reduce((a, b) => a + b, 0) / d.efficiencies.length) * 100) / 100
        : null,
    }));
  }

  /**
   * Get pool-wide efficiency metrics.
   * @returns {{ totalActualHashrate, totalExpectedHashrate, poolEfficiency, minerCount, identifiedCount, modelBreakdown }}
   */
  getPoolEfficiency() {
    let totalActual = 0;
    let totalExpected = 0;
    let minerCount = 0;
    let identifiedCount = 0;

    if (this.workers && this.workers.workers) {
      for (const [, worker] of this.workers.workers) {
        minerCount++;
        const hr = this.hashrate.getWorkerHashrate(worker.clientId);
        if (hr) totalActual += hr;

        if (worker.modelKey) {
          identifiedCount++;
          const expected = this.registry.getExpectedHashrate(worker.modelKey);
          if (expected) totalExpected += expected;
        }
      }
    }

    const poolEfficiency = totalExpected > 0 ? totalActual / totalExpected : null;

    return {
      totalActualHashrate: totalActual,
      totalExpectedHashrate: totalExpected,
      poolEfficiency: poolEfficiency ? Math.round(poolEfficiency * 100) / 100 : null,
      minerCount,
      identifiedCount,
      modelBreakdown: this.getModelDistribution(),
    };
  }

  /**
   * Get full optimization report — pool-level recommendations.
   * @returns {object}
   */
  getOptimizationReport() {
    const efficiency = this.getPoolEfficiency();
    const recommendations = [];

    if (efficiency.poolEfficiency !== null && efficiency.poolEfficiency < UNDERPERFORMANCE_THRESHOLD) {
      recommendations.push({
        type: 'pool_underperformance',
        severity: 'warning',
        message: `Pool efficiency is ${Math.round(efficiency.poolEfficiency * 100)}%. Check for hardware issues across fleet.`,
      });
    }

    if (efficiency.identifiedCount < efficiency.minerCount * 0.5) {
      recommendations.push({
        type: 'low_identification',
        severity: 'info',
        message: `Only ${efficiency.identifiedCount}/${efficiency.minerCount} miners identified. Consider updating miner registry.`,
      });
    }

    // Per-model recommendations
    for (const model of efficiency.modelBreakdown) {
      if (model.avgEfficiency !== null && model.avgEfficiency < UNDERPERFORMANCE_THRESHOLD) {
        recommendations.push({
          type: 'model_underperformance',
          severity: 'warning',
          model: model.model,
          message: `${model.model} fleet averaging ${Math.round(model.avgEfficiency * 100)}% efficiency (${model.count} units).`,
        });
      }
    }

    return {
      ...efficiency,
      recommendations,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get model benchmarks — avg performance per model from historical data.
   * @returns {Array}
   */
  async getModelBenchmarks() {
    try {
      const result = await this.db.query(
        `SELECT miner_model,
                COUNT(*) as samples,
                AVG(efficiency) as avg_efficiency,
                AVG(actual_hashrate) as avg_hashrate,
                AVG(stale_rate) as avg_stale_rate
         FROM miner_performance
         WHERE created_at > NOW() - INTERVAL '7 days'
         GROUP BY miner_model
         ORDER BY avg_efficiency DESC`
      );
      return result.rows;
    } catch (err) {
      log.error({ err: err.message }, 'Failed to fetch model benchmarks');
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════
  // INTERNAL
  // ═══════════════════════════════════════════════════════

  async _analyzeAll() {
    if (!this.workers || !this.workers.workers) return;

    for (const [, worker] of this.workers.workers) {
      if (!worker.modelKey || !worker.minerAddress) continue;

      const analysis = this.analyzeWorker(worker.clientId, worker.modelKey);
      if (analysis.efficiency === null) continue;

      // Persist performance snapshot
      try {
        await this.db.query(
          `INSERT INTO miner_performance (address, worker_name, miner_model, expected_hashrate, actual_hashrate, efficiency, stale_rate)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            worker.minerAddress,
            worker.workerName,
            worker.minerModel,
            analysis.expectedHashrate,
            analysis.actualHashrate,
            analysis.efficiency,
            worker.staleShares > 0 ? worker.staleShares / (worker.validShares + worker.staleShares) : 0,
          ]
        );
      } catch (err) {
        log.error({ err: err.message }, 'Failed to persist performance data');
      }

      if (analysis.status === 'critical') {
        log.warn({
          address: worker.minerAddress,
          model: worker.minerModel,
          efficiency: analysis.efficiency,
        }, 'Critical underperformance detected');
      }
    }
  }
}

module.exports = HashrateOptimizer;
