/**
 * LUXXPOOL v0.7.0 — Dashboard API Routes
 * Aggregated endpoints optimized for dashboard visualization.
 * Designed for external dashboard webapps to consume.
 */

const { createLogger } = require('../../utils/logger');
const { API } = require('../../ux/copy');
const HashrateEstimator = require('../../monitoring/hashrateEstimator');
const config = require('../../../config');

const log = createLogger('dashboard-api');

function registerDashboardRoutes(app, deps) {
  const {
    db, redis, rpcClient, stratumServer, redisKeys,
    hashrateEstimator, hashrateOptimizer, firmwareTracker,
    minerRegistry, securityManager, banningManager,
    emergencyLockdown, ipReputation, auditLogger,
    poolWebSocket,
  } = deps;

  // Admin auth middleware (reused from security routes)
  const requireAdmin = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!config.api.adminToken || token !== config.api.adminToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };

  // ═══════════════════════════════════════════════════════
  // PUBLIC DASHBOARD ENDPOINTS
  // ═══════════════════════════════════════════════════════

  /**
   * GET /api/v1/dashboard/overview
   * Combined pool + network + aux chain status in a single call.
   * Designed to populate the main dashboard view.
   */
  app.get('/api/v1/dashboard/overview', async (req, res) => {
    try {
      const [miningInfo, blockchainInfo] = await Promise.all([
        rpcClient.getMiningInfo().catch(() => null),
        rpcClient.getBlockchainInfo().catch(() => null),
      ]);

      const poolHashrate = hashrateEstimator ? hashrateEstimator.getPoolHashrate() : 0;
      const activeMiners = stratumServer ? stratumServer.clients.size : 0;
      const totalShares = await redis.get(redisKeys.totalShares()).catch(() => 0);

      // Recent blocks (last 5)
      const blocksResult = await db.query(
        'SELECT coin, height, hash, reward, confirmations, confirmed, orphaned, created_at FROM blocks ORDER BY created_at DESC LIMIT 5'
      );

      // Aux chain status
      const auxResult = await db.query(
        `SELECT coin, COUNT(*) as blocks_found, MAX(created_at) as last_block
         FROM aux_blocks GROUP BY coin`
      );

      // Miner model distribution (if optimizer available)
      const modelDist = hashrateOptimizer ? hashrateOptimizer.getModelDistribution() : [];

      // Lockdown status
      const lockdownStatus = emergencyLockdown ? emergencyLockdown.getStatus() : { level: 0, name: 'normal' };

      res.json({
        pool: {
          name: config.pool.name,
          version: require('../../../package.json').version,
          hashrate: poolHashrate,
          hashrateFormatted: HashrateEstimator.formatHashrate(poolHashrate),
          miners: activeMiners,
          fee: config.pool.fee * 100 + '%',
          totalShares: parseInt(totalShares || 0),
          uptime: process.uptime(),
          lockdownLevel: lockdownStatus.level,
        },
        network: miningInfo ? {
          difficulty: miningInfo.difficulty,
          hashrate: miningInfo.networkhashps,
          height: miningInfo.blocks,
        } : null,
        recentBlocks: blocksResult.rows,
        auxChains: auxResult.rows,
        minerModels: modelDist,
        websocket: {
          available: !!poolWebSocket,
          url: config.websocket?.enabled ? '/ws' : null,
        },
      });
    } catch (err) {
      log.error({ err: err.message }, 'Dashboard overview error');
      res.status(500).json(API.errors.INTERNAL);
    }
  });

  /**
   * GET /api/v1/dashboard/hashrate-chart
   * Time-bucketed hashrate data for chart rendering.
   * Query: ?hours=24&bucketMinutes=30
   */
  app.get('/api/v1/dashboard/hashrate-chart', async (req, res) => {
    const hours = Math.min(parseInt(req.query.hours || '24'), 168); // Max 7 days
    const bucketMinutes = Math.max(parseInt(req.query.bucketMinutes || '30'), 5);

    try {
      const result = await db.query(
        `SELECT
           date_trunc('hour', created_at) + (EXTRACT(minute FROM created_at)::int / $3 * $3) * INTERVAL '1 minute' AS bucket,
           AVG(hashrate) as avg_hashrate,
           MAX(hashrate) as max_hashrate,
           MIN(hashrate) as min_hashrate,
           AVG(miners_active) as avg_miners
         FROM pool_stats
         WHERE created_at > NOW() - INTERVAL '1 hour' * $1
         GROUP BY bucket
         ORDER BY bucket ASC`,
        [hours, hours, bucketMinutes]
      );

      res.json({
        hours,
        bucketMinutes,
        dataPoints: result.rows.map(row => ({
          timestamp: row.bucket,
          hashrate: parseFloat(row.avg_hashrate) || 0,
          maxHashrate: parseFloat(row.max_hashrate) || 0,
          minHashrate: parseFloat(row.min_hashrate) || 0,
          miners: Math.round(parseFloat(row.avg_miners) || 0),
        })),
      });
    } catch (err) {
      log.error({ err: err.message }, 'Hashrate chart error');
      res.status(500).json(API.errors.INTERNAL);
    }
  });

  /**
   * GET /api/v1/dashboard/block-frequency
   * Blocks found per time period for bar chart visualization.
   * Query: ?days=30&groupBy=day (day|hour)
   */
  app.get('/api/v1/dashboard/block-frequency', async (req, res) => {
    const days = Math.min(parseInt(req.query.days || '30'), 90);
    const groupBy = req.query.groupBy === 'hour' ? 'hour' : 'day';

    try {
      const result = await db.query(
        `SELECT
           date_trunc($1, created_at) AS period,
           coin,
           COUNT(*) as block_count,
           SUM(CASE WHEN confirmed THEN 1 ELSE 0 END) as confirmed_count,
           SUM(CASE WHEN orphaned THEN 1 ELSE 0 END) as orphaned_count
         FROM blocks
         WHERE created_at > NOW() - INTERVAL '1 day' * $2
         GROUP BY period, coin
         ORDER BY period ASC`,
        [groupBy, days]
      );

      res.json({ days, groupBy, periods: result.rows });
    } catch (err) {
      log.error({ err: err.message }, 'Block frequency error');
      res.status(500).json(API.errors.INTERNAL);
    }
  });

  /**
   * GET /api/v1/dashboard/miner-models
   * Miner model distribution for pie/donut chart.
   */
  app.get('/api/v1/dashboard/miner-models', (req, res) => {
    if (!hashrateOptimizer) {
      return res.json({ models: [], total: 0 });
    }

    const models = hashrateOptimizer.getModelDistribution();
    res.json({
      models,
      total: models.reduce((sum, m) => sum + m.count, 0),
    });
  });

  /**
   * GET /api/v1/dashboard/payment-history
   * Aggregated payment stats for charts.
   * Query: ?days=30
   */
  app.get('/api/v1/dashboard/payment-history', async (req, res) => {
    const days = Math.min(parseInt(req.query.days || '30'), 90);

    try {
      const result = await db.query(
        `SELECT
           date_trunc('day', created_at) AS day,
           coin,
           COUNT(*) as payment_count,
           SUM(amount) as total_amount,
           AVG(amount) as avg_amount
         FROM payments
         WHERE status = 'sent' AND created_at > NOW() - INTERVAL '1 day' * $1
         GROUP BY day, coin
         ORDER BY day ASC`,
        [days]
      );

      res.json({ days, payments: result.rows });
    } catch (err) {
      log.error({ err: err.message }, 'Payment history error');
      res.status(500).json(API.errors.INTERNAL);
    }
  });

  /**
   * GET /api/v1/dashboard/efficiency
   * Pool efficiency metrics (hashrate optimizer data).
   */
  app.get('/api/v1/dashboard/efficiency', (req, res) => {
    if (!hashrateOptimizer) {
      return res.json({ available: false });
    }

    const report = hashrateOptimizer.getOptimizationReport();
    res.json({ available: true, ...report });
  });

  // ═══════════════════════════════════════════════════════
  // ADMIN DASHBOARD ENDPOINTS (require auth)
  // ═══════════════════════════════════════════════════════

  /**
   * GET /api/v1/dashboard/security-feed
   * Recent security events for admin dashboard.
   * Query: ?limit=50&severity=high
   */
  app.get('/api/v1/dashboard/security-feed', requireAdmin, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const severity = req.query.severity || null;

    try {
      let query = 'SELECT * FROM security_events ORDER BY created_at DESC LIMIT $1';
      let params = [limit];

      if (severity) {
        query = 'SELECT * FROM security_events WHERE severity = $2 ORDER BY created_at DESC LIMIT $1';
        params = [limit, severity];
      }

      const result = await db.query(query, params);

      // Add lockdown status
      const lockdown = emergencyLockdown ? emergencyLockdown.getStatus() : null;
      const highRiskIPs = ipReputation ? ipReputation.getHighRiskIPs().slice(0, 10) : [];

      res.json({
        events: result.rows,
        lockdown,
        highRiskIPs,
        websocketStats: poolWebSocket ? poolWebSocket.getStats() : null,
      });
    } catch (err) {
      log.error({ err: err.message }, 'Security feed error');
      res.status(500).json(API.errors.INTERNAL);
    }
  });

  /**
   * GET /api/v1/dashboard/firmware-status
   * Fleet firmware overview for admin dashboard.
   */
  app.get('/api/v1/dashboard/firmware-status', requireAdmin, (req, res) => {
    if (!firmwareTracker) {
      return res.json({ available: false });
    }

    const status = firmwareTracker.getFleetFirmwareStatus();
    const outdated = firmwareTracker.getOutdatedMiners();

    res.json({ available: true, ...status, outdatedMiners: outdated });
  });

  // ═══════════════════════════════════════════════════════
  // ADMIN CONTROL ENDPOINTS
  // ═══════════════════════════════════════════════════════

  /**
   * GET /api/v1/admin/lockdown
   * Get current lockdown status.
   */
  app.get('/api/v1/admin/lockdown', requireAdmin, (req, res) => {
    if (!emergencyLockdown) {
      return res.json({ available: false });
    }
    res.json(emergencyLockdown.getStatus());
  });

  /**
   * POST /api/v1/admin/lockdown
   * Set lockdown level. Body: { level, reason, durationMinutes? }
   */
  app.post('/api/v1/admin/lockdown', requireAdmin, (req, res) => {
    if (!emergencyLockdown) {
      return res.status(503).json({ error: 'Lockdown system not available' });
    }

    const { level, reason, durationMinutes } = req.body;
    if (level === undefined || level < 0 || level > 3) {
      return res.status(400).json({ error: 'Invalid level (0-3)' });
    }

    const adminIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const durationMs = durationMinutes ? durationMinutes * 60000 : undefined;

    const success = emergencyLockdown.setLevel(level, reason || 'Manual lockdown', adminIp, durationMs);

    if (auditLogger) {
      auditLogger.logLockdownChange(emergencyLockdown.level, level, reason, `admin:${adminIp}`);
    }

    res.json({ success, status: emergencyLockdown.getStatus() });
  });

  /**
   * GET /api/v1/admin/reputation/:ip
   * Get IP reputation details.
   */
  app.get('/api/v1/admin/reputation/:ip', requireAdmin, (req, res) => {
    if (!ipReputation) {
      return res.json({ available: false });
    }
    res.json(ipReputation.getReputation(req.params.ip));
  });

  /**
   * GET /api/v1/admin/audit
   * Query audit log. Query: ?type=ban&severity=high&limit=100
   */
  app.get('/api/v1/admin/audit', requireAdmin, async (req, res) => {
    if (!auditLogger) {
      return res.json({ available: false });
    }

    const entries = await auditLogger.query({
      type: req.query.type,
      severity: req.query.severity,
      limit: parseInt(req.query.limit || '100'),
      offset: parseInt(req.query.offset || '0'),
    });

    const summary = await auditLogger.getSummary();

    res.json({ entries, summary });
  });

  /**
   * POST /api/v1/admin/rotate-key
   * Rotate the admin API token. Returns new token.
   * Note: New token must be saved to environment/config manually.
   */
  app.post('/api/v1/admin/rotate-key', requireAdmin, (req, res) => {
    const crypto = require('crypto');
    const newToken = crypto.randomBytes(32).toString('hex');
    const adminIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

    // Update in-memory config (restart required for persistence)
    config.api.adminToken = newToken;

    if (auditLogger) {
      auditLogger.logAdminAction('key_rotated', { note: 'API admin token rotated' }, adminIp);
    }

    log.warn({ admin: adminIp }, 'Admin API token rotated — update environment variable API_ADMIN_TOKEN');

    res.json({
      token: newToken,
      note: 'Token updated in memory. Set API_ADMIN_TOKEN environment variable and restart for persistence.',
    });
  });
}

module.exports = { registerDashboardRoutes };
