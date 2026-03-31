const { API } = require('../../ux/copy');
/**
 * LUXXPOOL — Security API Routes
 * All endpoints use the 9-layer SecurityEngine (v0.7.0+)
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
  const { securityEngine, db } = deps;

  // Security dashboard overview (9-layer engine status)
  app.get('/api/v1/security/status', requireAdminAuth, async (req, res) => {
    if (!securityEngine) return res.json({ status: 'disabled' });
    try {
      res.json(await securityEngine.getStatus());
    } catch (err) {
      log.error({ err: err.message }, 'SecurityEngine status error');
      res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
    }
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

  // Miner profile (fingerprinting data from L4)
  app.get('/api/v1/security/miner/:address', requireAdminAuth, async (req, res) => {
    if (!securityEngine) return res.json({ status: 'disabled' });

    const profile = securityEngine.layers.fingerprint.getProfile(req.params.address);
    if (!profile) return res.status(API.errors.MINER_NOT_TRACKED.status).json(API.errors.MINER_NOT_TRACKED);

    const score = await securityEngine.getReputation(req.params.address);

    res.json({
      address: req.params.address,
      totalShares: profile.total,
      blocksFound: profile.full,
      staleShares: profile.stale,
      reputationScore: score,
      firstSeen: profile.firstSeen,
      lastSeen: profile.lastSeen,
    });
  });

  // Audit trail query
  app.get('/api/v1/security/engine/audit', requireAdminAuth, (req, res) => {
    if (!securityEngine) return res.json({ events: [] });
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
    if (!securityEngine) return res.json({ score: null });
    try {
      const score = await securityEngine.getReputation(req.params.address);
      res.json({ address: req.params.address, score });
    } catch (err) {
      log.error({ err: err.message }, 'SecurityEngine reputation query error');
      res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
    }
  });
}

module.exports = { registerSecurityRoutes };
