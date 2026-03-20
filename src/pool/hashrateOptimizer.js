/**
 * LUXXPOOL v0.7.0 — Hashrate Optimization Engine
 * ═══════════════════════════════════════════════════════════
 * Per-miner efficiency analysis comparing actual hashrate
 * (from HashrateEstimator) vs expected hashrate (from MinerRegistry).
 *
 * Features:
 *   - Per-miner efficiency ratio (actual / expected)
 *   - Underperformance detection (<80% warning, <50% critical)
 *   - Pool-wide optimization metrics
 *   - Model distribution analysis
 *   - Actionable optimization suggestions
 *
 * This engine helps operators identify:
 *   - Miners running below capacity (cooling issues, firmware bugs)
 *   - Miners that would benefit from firmware updates
 *   - Optimal difficulty settings per model
 *   - Pool-wide hashrate efficiency trends
 */

const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');

const log = createLogger('optimizer');

class HashrateOptimizer extends EventEmitter {
  /**
   * @param {object} deps - { hashrateEstimator, minerRegistry, workerTracker }
   * @param {object} opts
   */
  constructor(deps = {}, opts = {}) {
    super();

    this.hashrateEstimator = deps.hashrateEstimator;
    this.minerRegistry = deps.minerRegistry;
    this.workerTracker = deps.workerTracker;

    this.analysisIntervalMs = opts.analysisIntervalMs || 60000; // 1 min
    this.warningThreshold = opts.warningThreshold || 0.80;  // 80%
    this.criticalThreshold = opts.criticalThreshold || 0.50; // 50%

    // Per-miner optimization data: clientId → OptimizationProfile
    this.profiles = new Map();

    // Latest pool-wide report
    this.lastReport = null;

    this.analysisTimer = null;
  }

  start() {
    this.analysisTimer = setInterval(() => this._analyze(), this.analysisIntervalMs);
    log.info({
      warningThreshold: this.warningThreshold * 100 + '%',
      criticalThreshold: this.criticalThreshold * 100 + '%',
    }, 'Hashrate optimizer started');
  }

  stop() {
    if (this.analysisTimer) clearInterval(this.analysisTimer);
  }

  /**
   * Register a miner with its identified model.
   * Called when model is detected during subscribe/authorize.
   */
  registerMiner(clientId, minerAddress, modelKey) {
    const expectedHashrate = this.minerRegistry.getExpectedHashrate(modelKey);
    if (!expectedHashrate) return;

    this.profiles.set(clientId, {
      clientId,
      minerAddress,
      modelKey,
      modelName: this.minerRegistry.models[modelKey]?.name || modelKey,
      expectedHashrate,
      actualHashrate: 0,
      efficiency: 0,
      status: 'unknown', // unknown, optimal, warning, critical
      suggestions: [],
      lastAnalysis: null,
    });
  }

  /**
   * Remove miner on disconnect.
   */
  removeMiner(clientId) {
    this.profiles.delete(clientId);
  }

  /**
   * Get optimization report for a specific miner.
   */
  getMinerReport(clientId) {
    return this.profiles.get(clientId) || null;
  }

  /**
   * Get the latest pool-wide optimization report.
   */
  getOptimizationReport() {
    return this.lastReport;
  }

  /**
   * Get per-model efficiency breakdown for dashboard.
   */
  getModelEfficiency() {
    const models = {};

    for (const [, profile] of this.profiles) {
      if (!models[profile.modelName]) {
        models[profile.modelName] = {
          name: profile.modelName,
          count: 0,
          totalActual: 0,
          totalExpected: 0,
          avgEfficiency: 0,
          optimal: 0,
          warning: 0,
          critical: 0,
        };
      }

      const m = models[profile.modelName];
      m.count++;
      m.totalActual += profile.actualHashrate;
      m.totalExpected += profile.expectedHashrate;

      if (profile.status === 'optimal') m.optimal++;
      else if (profile.status === 'warning') m.warning++;
      else if (profile.status === 'critical') m.critical++;
    }

    // Calculate averages
    for (const m of Object.values(models)) {
      m.avgEfficiency = m.totalExpected > 0
        ? Math.round((m.totalActual / m.totalExpected) * 10000) / 100
        : 0;
    }

    return models;
  }

  // ─── Internal ──────────────────────────────────────────

  _analyze() {
    if (!this.hashrateEstimator) return;

    let totalActual = 0;
    let totalExpected = 0;
    let optimalCount = 0;
    let warningCount = 0;
    let criticalCount = 0;
    let unknownCount = 0;
    const suggestions = [];

    for (const [clientId, profile] of this.profiles) {
      // Get actual hashrate from estimator
      const actualHashrate = this.hashrateEstimator.getWorkerHashrate(clientId);
      profile.actualHashrate = actualHashrate;

      if (actualHashrate === 0) {
        profile.status = 'unknown';
        profile.efficiency = 0;
        unknownCount++;
        continue;
      }

      // Calculate efficiency
      const efficiency = actualHashrate / profile.expectedHashrate;
      profile.efficiency = Math.round(efficiency * 10000) / 100; // percentage with 2 decimals
      profile.lastAnalysis = Date.now();

      totalActual += actualHashrate;
      totalExpected += profile.expectedHashrate;

      // Classify status
      profile.suggestions = [];

      if (efficiency >= this.warningThreshold) {
        profile.status = 'optimal';
        optimalCount++;
      } else if (efficiency >= this.criticalThreshold) {
        profile.status = 'warning';
        warningCount++;

        profile.suggestions.push('Check cooling and ambient temperature');
        profile.suggestions.push('Consider firmware update if available');

        this.emit('underperformance', {
          clientId,
          address: profile.minerAddress,
          model: profile.modelName,
          efficiency: profile.efficiency,
          severity: 'warning',
        });
      } else {
        profile.status = 'critical';
        criticalCount++;

        profile.suggestions.push('CRITICAL: Miner operating far below capacity');
        profile.suggestions.push('Check hardware health and hash board status');
        profile.suggestions.push('Verify firmware version and update if needed');
        profile.suggestions.push('Inspect power supply and voltage');

        this.emit('underperformance', {
          clientId,
          address: profile.minerAddress,
          model: profile.modelName,
          efficiency: profile.efficiency,
          severity: 'critical',
        });
      }
    }

    // Build pool-wide report
    const poolEfficiency = totalExpected > 0
      ? Math.round((totalActual / totalExpected) * 10000) / 100
      : 0;

    this.lastReport = {
      timestamp: Date.now(),
      pool: {
        totalActualHashrate: totalActual,
        totalExpectedHashrate: totalExpected,
        efficiency: poolEfficiency,
        optimizationScore: this._calculateScore(poolEfficiency, warningCount, criticalCount),
      },
      miners: {
        total: this.profiles.size,
        optimal: optimalCount,
        warning: warningCount,
        critical: criticalCount,
        unknown: unknownCount,
      },
      modelDistribution: this.getModelEfficiency(),
      suggestions: this._poolSuggestions(warningCount, criticalCount, poolEfficiency),
    };

    this.emit('optimizationReport', this.lastReport);

    if (criticalCount > 0) {
      log.warn({
        poolEfficiency: poolEfficiency + '%',
        critical: criticalCount,
        warning: warningCount,
      }, 'Hashrate optimization: critical underperformance detected');
    }
  }

  /**
   * Calculate pool optimization score (0-100).
   */
  _calculateScore(efficiency, warnings, criticals) {
    let score = efficiency; // base score from efficiency percentage
    score -= warnings * 2;  // -2 per warning
    score -= criticals * 5; // -5 per critical
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Generate pool-level optimization suggestions.
   */
  _poolSuggestions(warnings, criticals, efficiency) {
    const suggestions = [];

    if (criticals > 0) {
      suggestions.push(`${criticals} miner(s) critically underperforming — investigate immediately`);
    }
    if (warnings > 0) {
      suggestions.push(`${warnings} miner(s) below 80% efficiency — consider firmware updates`);
    }
    if (efficiency < 90 && efficiency > 0) {
      suggestions.push('Pool efficiency below 90% — review cooling infrastructure');
    }
    if (efficiency >= 95) {
      suggestions.push('Pool operating at optimal efficiency');
    }

    return suggestions;
  }
}

module.exports = HashrateOptimizer;
