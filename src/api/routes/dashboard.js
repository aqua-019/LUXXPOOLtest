/**
 * LUXXPOOL v0.7.0 — Dashboard API Routes
 * ═══════════════════════════════════════════════════════════
 * Aggregated endpoints for dashboard consumption.
 * 8 public endpoints + 6 admin endpoints.
 *
 * Public endpoints return data suitable for visualization:
 *   - Time-series hashrate charts
 *   - Block frequency analysis
 *   - Miner model distribution
 *   - Pool efficiency metrics
 *   - Payment history
 *   - Security event counts (non-sensitive)
 *   - Firmware status distribution
 *
 * Admin endpoints (require Authorization: Bearer <token>):
 *   - Emergency lockdown control
 *   - IP reputation viewer
 *   - Audit log
 *   - API key rotation
 *   - Connection fingerprint data
 */

const config = require('../../../config');
const { createLogger } = require('../../utils/logger');
const { API } = require('../../ux/copy');

const log = createLogger('dashboard-api');

/**
 * Admin auth middleware
 */
function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!config.api.adminToken || token !== config.api.adminToken) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  next();
}

function registerDashboardRoutes(app, deps) {
  const { db, stratumServer, hashrateEstimator, rpcClient,
          hashrateOptimizer, ipReputation, emergencyLockdown,
          auditLog, firmwareTracker, connectionFingerprint,
          workerTracker, minerRegistry } = deps;

  // ═══════════════════════════════════════════════════════
  // PUBLIC DASHBOARD ENDPOINTS
  // ═══════════════════════════════════════════════════════

  /**
   * Pool overview — aggregated summary for main dashboard view
   */
  app.get('/api/v1/dashboard/overview', async (req, res) => {
    try {
      const poolHashrate = hashrateEstimator ? hashrateEstimator.getPoolHashrate() : 0;
      const activeMiners = stratumServer ? stratumServer.clients.size : 0;
      const miningInfo = await rpcClient.getMiningInfo().catch(() => null);

      const blocksResult = await db.query(
        "SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE confirmed = true) as confirmed FROM blocks"
      );

      const optimizationReport = hashrateOptimizer ? hashrateOptimizer.getOptimizationReport() : null;

      res.json({
        pool: {
          hashrate: poolHashrate,
          miners: activeMiners,
          fee: config.pool.fee * 100 + '%',
          uptime: process.uptime(),
          lockdownLevel: emergencyLockdown ? emergencyLockdown.getLevel() : 0,
          lockdownName: emergencyLockdown ? emergencyLockdown.getLevelName() : 'Normal',
        },
        network: miningInfo ? {
          difficulty: miningInfo.difficulty,
          hashrate: miningInfo.networkhashps,
          height: miningInfo.blocks,
        } : null,
        blocks: {
          total: parseInt(blocksResult.rows[0]?.total || 0),
          confirmed: parseInt(blocksResult.rows[0]?.confirmed || 0),
        },
        efficiency: optimizationReport ? {
          poolEfficiency: optimizationReport.pool.efficiency,
          optimizationScore: optimizationReport.pool.optimizationScore,
          minersOptimal: optimizationReport.miners.optimal,
          minersWarning: optimizationReport.miners.warning,
          minersCritical: optimizationReport.miners.critical,
        } : null,
      });
    } catch (err) {
      log.error({ err: err.message }, 'Dashboard overview error');
      res.status(500).json(API.errors.INTERNAL);
    }
  });

  /**
   * Hashrate chart — time-series data for visualization
   */
  app.get('/api/v1/dashboard/hashrate-chart', async (req, res) => {
    const hours = Math.min(parseInt(req.query.hours || '24'), 168); // max 7 days

    try {
      const result = await db.query(
        `SELECT hashrate, miners_active, created_at
         FROM pool_stats
         WHERE created_at > NOW() - INTERVAL '1 hour' * $1
         ORDER BY created_at ASC`,
        [hours]
      );

      res.json({
        period: hours + 'h',
        dataPoints: result.rows.length,
        data: result.rows.map(r => ({
          hashrate: r.hashrate,
          miners: r.miners_active,
          timestamp: r.created_at,
        })),
      });
    } catch (err) {
      log.error({ err: err.message }, 'Hashrate chart error');
      res.status(500).json(API.errors.INTERNAL);
    }
  });

  /**
   * Block frequency — blocks found per period with coin breakdown
   */
  app.get('/api/v1/dashboard/block-frequency', async (req, res) => {
    try {
      const hourly = await db.query(
        `SELECT coin, DATE_TRUNC('hour', created_at) as hour, COUNT(*) as count
         FROM blocks
         WHERE created_at > NOW() - INTERVAL '24 hours'
         GROUP BY coin, hour ORDER BY hour ASC`
      );

      const daily = await db.query(
        `SELECT coin, DATE_TRUNC('day', created_at) as day, COUNT(*) as count
         FROM blocks
         WHERE created_at > NOW() - INTERVAL '30 days'
         GROUP BY coin, day ORDER BY day ASC`
      );

      res.json({ hourly: hourly.rows, daily: daily.rows });
    } catch (err) {
      log.error({ err: err.message }, 'Block frequency error');
      res.status(500).json(API.errors.INTERNAL);
    }
  });

  /**
   * Miner models — distribution of connected ASIC models
   */
  app.get('/api/v1/dashboard/miner-models', async (req, res) => {
    try {
      const distribution = workerTracker ? workerTracker.getModelDistribution() : {};
      const allModels = minerRegistry ? minerRegistry.getAllModels() : [];

      res.json({ distribution, registeredModels: allModels });
    } catch (err) {
      log.error({ err: err.message }, 'Miner models error');
      res.status(500).json(API.errors.INTERNAL);
    }
  });

  /**
   * Payment history — recent payments for dashboard display
   */
  app.get('/api/v1/dashboard/payment-history', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const offset = parseInt(req.query.offset || '0');

    try {
      const result = await db.query(
        `SELECT address, amount, txid, coin, status, created_at
         FROM payments
         WHERE status = 'sent'
         ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      const totalResult = await db.query(
        "SELECT COUNT(*) FROM payments WHERE status = 'sent'"
      );

      res.json({
        payments: result.rows,
        total: parseInt(totalResult.rows[0]?.count || 0),
        limit,
        offset,
      });
    } catch (err) {
      log.error({ err: err.message }, 'Payment history error');
      res.status(500).json(API.errors.INTERNAL);
    }
  });

  /**
   * Efficiency — pool and per-model efficiency metrics
   */
  app.get('/api/v1/dashboard/efficiency', (req, res) => {
    const report = hashrateOptimizer ? hashrateOptimizer.getOptimizationReport() : null;
    const modelEfficiency = hashrateOptimizer ? hashrateOptimizer.getModelEfficiency() : {};

    res.json({
      pool: report ? report.pool : null,
      miners: report ? report.miners : null,
      models: modelEfficiency,
      suggestions: report ? report.suggestions : [],
    });
  });

  /**
   * Security feed — recent security events (public: counts and types only)
   */
  app.get('/api/v1/dashboard/security-feed', async (req, res) => {
    try {
      const counts = await db.query(
        `SELECT type, severity, COUNT(*) as count
         FROM security_events
         WHERE created_at > NOW() - INTERVAL '24 hours'
         GROUP BY type, severity
         ORDER BY count DESC`
      );

      const total = await db.query(
        "SELECT COUNT(*) FROM security_events WHERE created_at > NOW() - INTERVAL '24 hours'"
      );

      res.json({
        last24h: parseInt(total.rows[0]?.count || 0),
        breakdown: counts.rows,
        lockdownLevel: emergencyLockdown ? emergencyLockdown.getLevel() : 0,
      });
    } catch (err) {
      log.error({ err: err.message }, 'Security feed error');
      res.status(500).json(API.errors.INTERNAL);
    }
  });

  /**
   * Firmware status — firmware version distribution
   */
  app.get('/api/v1/dashboard/firmware-status', (req, res) => {
    const distribution = firmwareTracker ? firmwareTracker.getDistribution() : {
      total: 0, current: 0, outdated: 0, critical: 0, unknown: 0, byModel: {},
    };

    res.json(distribution);
  });

  // ═══════════════════════════════════════════════════════
  // ADMIN ENDPOINTS (require Bearer token)
  // ═══════════════════════════════════════════════════════

  /**
   * Set emergency lockdown level
   */
  app.post('/api/v1/admin/lockdown', requireAdmin, async (req, res) => {
    const { level, reason } = req.body || {};

    if (level === undefined || level < 0 || level > 3) {
      return res.status(400).json({ error: 'Level must be 0-3' });
    }

    if (emergencyLockdown) {
      const success = await emergencyLockdown.setLevel(level, 'admin', reason || 'Admin override');
      res.json({ success, level, levelName: emergencyLockdown.getLevelName() });
    } else {
      res.status(503).json({ error: 'Lockdown system not available' });
    }
  });

  /**
   * Get lockdown status + history
   */
  app.get('/api/v1/admin/lockdown/status', requireAdmin, async (req, res) => {
    const status = emergencyLockdown ? emergencyLockdown.getStatus() : null;
    const history = emergencyLockdown ? await emergencyLockdown.getHistory() : [];

    res.json({ status, history });
  });

  /**
   * View IP reputation scores
   */
  app.get('/api/v1/admin/ip-reputation', requireAdmin, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100'), 500);
    const offset = parseInt(req.query.offset || '0');

    const scores = ipReputation ? ipReputation.getAll(limit, offset) : [];
    res.json({ scores, count: scores.length });
  });

  /**
   * Paginated audit log
   */
  app.get('/api/v1/admin/audit-log', requireAdmin, async (req, res) => {
    const filters = {
      eventType: req.query.type,
      severity: req.query.severity,
      actor: req.query.actor,
      since: req.query.since,
      limit: parseInt(req.query.limit || '50'),
      offset: parseInt(req.query.offset || '0'),
    };

    const entries = auditLog ? await auditLog.query(filters) : [];
    res.json({ entries, count: entries.length });
  });

  /**
   * Rotate admin API key
   */
  app.post('/api/v1/admin/api-key/rotate', requireAdmin, (req, res) => {
    // Token rotation is disabled — in-memory changes are lost on restart,
    // creating a false sense of security. Rotate via API_ADMIN_TOKEN env var.
    res.status(501).json({
      error: 'Token rotation via API is disabled. Update the API_ADMIN_TOKEN environment variable and restart the pool.',
    });
  });

  /**
   * Connection fingerprint / cluster data
   */
  app.get('/api/v1/admin/connections', requireAdmin, (req, res) => {
    const clusters = connectionFingerprint ? connectionFingerprint.getClusters() : [];
    const activeProfiles = connectionFingerprint ? connectionFingerprint.getActiveCount() : 0;

    res.json({ clusters, activeProfiles });
  });
}

module.exports = { registerDashboardRoutes };
