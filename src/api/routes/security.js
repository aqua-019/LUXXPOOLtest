const { API } = require('../../ux/copy');
/**
 * LUXXPOOL v0.3.0 — Security API Routes
 */

const { createLogger } = require('../../utils/logger');
const config = require('../../../config');
const log = createLogger('api:security');

function requireAdminAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!config.api.adminToken) {
    return res.status(503).json({ error: 'Admin token not configured' });
  }
  if (token !== config.api.adminToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function registerSecurityRoutes(app, deps) {
  const { securityManager, db } = deps;

  // Security dashboard overview
  app.get('/api/v1/security/status', requireAdminAuth, (req, res) => {
    if (!securityManager) return res.json({ status: 'disabled' });
    res.json(securityManager.getDashboard());
  });

  // Recent security events
  app.get('/api/v1/security/events', requireAdminAuth, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const severity = req.query.severity;

    try {
      let q = 'SELECT * FROM security_events';
      const params = [];

      if (severity) {
        q += ' WHERE severity = $1';
        params.push(severity.toUpperCase());
      }

      q += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
      params.push(limit);

      const result = await db.query(q, params);
      res.json({ events: result.rows, total: result.rows.length });
    } catch (err) {
      log.error({ err: err.message }, 'Security events query error');
      res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
    }
  });

  // Miner suspicion score
  app.get('/api/v1/security/miner/:address', requireAdminAuth, (req, res) => {
    if (!securityManager) return res.json({ status: 'disabled' });

    const stats = securityManager.fingerprintEngine.getStats(req.params.address);
    if (!stats) return res.status(API.errors.MINER_NOT_TRACKED.status).json(API.errors.MINER_NOT_TRACKED);

    res.json({
      address: req.params.address,
      totalShares: stats.totalShares,
      blocksFound: stats.fullPoW,
      suspicionScore: stats.suspicionScore,
      joinedAt: stats.joinedAt,
    });
  });
}

module.exports = { registerSecurityRoutes };
