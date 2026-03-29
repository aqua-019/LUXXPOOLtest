const { API } = require('../../ux/copy');
/**
 * LUXXPOOL — Security API Routes
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

  // ── SecurityEngine (9-layer) endpoints ──────────────────
  if (deps.securityEngine) {
    const securityEngine = deps.securityEngine;

    // 9-layer engine status overview
    app.get('/api/v1/security/engine/status', requireAdminAuth, async (req, res) => {
      try {
        res.json(await securityEngine.getStatus());
      } catch (err) {
        log.error({ err: err.message }, 'SecurityEngine status error');
        res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
      }
    });

    // Audit trail query
    app.get('/api/v1/security/engine/audit', requireAdminAuth, (req, res) => {
      try {
        const events = securityEngine.queryAudit({
          limit:       parseInt(req.query.limit) || 50,
          minSeverity: req.query.minSeverity || 'low',
          layer:       req.query.layer ? parseInt(req.query.layer) : undefined,
          address:     req.query.address,
        });
        res.json({ events });
      } catch (err) {
        log.error({ err: err.message }, 'SecurityEngine audit query error');
        res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
      }
    });

    // Miner reputation score
    app.get('/api/v1/security/reputation/:address', requireAdminAuth, async (req, res) => {
      try {
        const score = await securityEngine.getReputation(req.params.address);
        res.json({ address: req.params.address, score });
      } catch (err) {
        log.error({ err: err.message }, 'SecurityEngine reputation query error');
        res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
      }
    });
  }
}

module.exports = { registerSecurityRoutes };
