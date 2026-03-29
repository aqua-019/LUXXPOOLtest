/**
 * LUXXPOOL — REST API Server
 * Provides pool statistics, miner data, and admin endpoints
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { createLogger } = require('../utils/logger');
const { registerExtendedRoutes } = require('./routes/extended');
const { registerSecurityRoutes } = require('./routes/security');
const { registerPoolRoutes } = require('./routes/pool');
const { registerFleetRoutes } = require('./routes/fleet');
const { registerDashboardRoutes } = require('./routes/dashboard');
const { API } = require('../ux/copy');
const config = require('../../config');

const log = createLogger('api');

/**
 * Create and configure the API server
 * @param {object} deps - { db, redis, stratumServer, rpcClient }
 */
function createApiServer(deps) {
  const app = express();
  const { db, redis, stratumServer, rpcClient, redisKeys } = deps;

  // ── Middleware ──
  app.use(helmet());
  app.use(cors({ origin: config.api.corsOrigin }));
  app.use(compression());
  app.use(express.json());

  const limiter = rateLimit({
    windowMs: config.api.rateLimitWindow,
    max: config.api.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/', limiter);

  // ── Health ──
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', pool: config.pool.name, uptime: process.uptime() });
  });

  // ═══════════════════════════════════════════════════════
  // POOL STATS
  // ═══════════════════════════════════════════════════════

  app.get('/api/v1/pool/stats', async (req, res) => {
    try {
      const [miningInfo, blockchainInfo] = await Promise.all([
        rpcClient.getMiningInfo().catch(() => null),
        rpcClient.getBlockchainInfo().catch(() => null),
      ]);

      const poolHashrate = stratumServer ? stratumServer.getPoolHashrate() : 0;
      const activeWorkers = stratumServer ? stratumServer.clients.size : 0;
      const uniqueMiners = stratumServer
        ? new Set([...stratumServer.clients.values()]
            .filter(c => c.authorized && c.minerAddress)
            .map(c => c.minerAddress)).size
        : 0;

      const totalShares = await redis.get(redisKeys.totalShares()).catch(() => 0);

      // Recent blocks
      const blocksResult = await db.query(
        'SELECT * FROM blocks ORDER BY created_at DESC LIMIT 10'
      );

      res.json({
        pool: {
          name: config.pool.name,
          hashrate: poolHashrate,
          miners: uniqueMiners,
          workers: activeWorkers,
          fee: config.pool.fee * 100 + '%',
          totalShares: parseInt(totalShares || 0),
        },
        network: miningInfo ? {
          difficulty: miningInfo.difficulty,
          hashrate: miningInfo.networkhashps,
          height: miningInfo.blocks,
        } : null,
        blockchain: blockchainInfo ? {
          chain: blockchainInfo.chain,
          blocks: blockchainInfo.blocks,
          headers: blockchainInfo.headers,
          bestBlockHash: blockchainInfo.bestblockhash,
        } : null,
        recentBlocks: blocksResult.rows,
      });
    } catch (err) {
      log.error({ err: err.message }, 'Pool stats error');
      res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
    }
  });

  // ═══════════════════════════════════════════════════════
  // MINER ENDPOINTS
  // ═══════════════════════════════════════════════════════

  app.get('/api/v1/miner/:address', async (req, res) => {
    const { address } = req.params;

    try {
      // Miner info
      const minerResult = await db.query(
        'SELECT * FROM miners WHERE address = $1',
        [address]
      );

      if (minerResult.rows.length === 0) {
        return res.status(API.errors.MINER_NOT_FOUND.status).json(API.errors.MINER_NOT_FOUND);
      }

      const miner = minerResult.rows[0];

      // Workers
      const workersResult = await db.query(
        'SELECT * FROM workers WHERE miner_id = $1',
        [miner.id]
      );

      // Recent shares
      const sharesResult = await db.query(
        `SELECT SUM(difficulty) as total_diff, COUNT(*) as share_count
         FROM shares WHERE address = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
        [address]
      );

      // Payment history
      const paymentsResult = await db.query(
        'SELECT * FROM payments WHERE address = $1 ORDER BY created_at DESC LIMIT 20',
        [address]
      );

      // Pending balance from Redis
      const pendingBalance = await redis.get(redisKeys.pendingBalance(address)).catch(() => 0);

      res.json({
        miner,
        workers: workersResult.rows,
        stats24h: sharesResult.rows[0],
        payments: paymentsResult.rows,
        pendingBalance: parseFloat(pendingBalance || 0),
      });
    } catch (err) {
      log.error({ err: err.message, address }, 'Miner lookup error');
      res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
    }
  });

  // Miner hashrate history
  app.get('/api/v1/miner/:address/hashrate', async (req, res) => {
    const { address } = req.params;
    const hours = parseInt(req.query.hours || '24');

    try {
      const result = await db.query(
        `SELECT hashrate, created_at
         FROM miner_hashrate
         WHERE address = $1 AND created_at > NOW() - INTERVAL '1 hour' * $2
         ORDER BY created_at ASC`,
        [address, hours]
      );

      res.json({ address, hashrate: result.rows });
    } catch (err) {
      log.error({ err: err.message }, 'Hashrate history error');
      res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
    }
  });

  // ═══════════════════════════════════════════════════════
  // BLOCKS
  // ═══════════════════════════════════════════════════════

  app.get('/api/v1/blocks', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 100);
    const offset = parseInt(req.query.offset || '0');

    try {
      const result = await db.query(
        'SELECT * FROM blocks ORDER BY created_at DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      );

      const countResult = await db.query('SELECT COUNT(*) FROM blocks');

      res.json({
        blocks: result.rows,
        total: parseInt(countResult.rows[0].count),
        limit,
        offset,
      });
    } catch (err) {
      log.error({ err: err.message }, 'Blocks endpoint error');
      res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
    }
  });

  // ═══════════════════════════════════════════════════════
  // PAYMENTS
  // ═══════════════════════════════════════════════════════

  app.get('/api/v1/payments', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 100);

    try {
      const result = await db.query(
        'SELECT * FROM payments WHERE status = $1 ORDER BY created_at DESC LIMIT $2',
        ['sent', limit]
      );

      res.json({ payments: result.rows });
    } catch (err) {
      log.error({ err: err.message }, 'Payments endpoint error');
      res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
    }
  });

  // ═══════════════════════════════════════════════════════
  // CONNECTED MINERS (live)
  // ═══════════════════════════════════════════════════════

  app.get('/api/v1/miners/active', (req, res) => {
    if (!stratumServer) {
      return res.json({ miners: [] });
    }

    const miners = stratumServer.getClients()
      .filter(c => c.authorized)
      .map(c => c.toJSON());

    res.json({
      count: miners.length,
      miners,
      poolHashrate: stratumServer.getPoolHashrate(),
    });
  });

  // ═══════════════════════════════════════════════════════
  // POOL HASHRATE HISTORY
  // ═══════════════════════════════════════════════════════

  app.get('/api/v1/pool/hashrate', async (req, res) => {
    const hours = parseInt(req.query.hours || '24');

    try {
      const result = await db.query(
        `SELECT hashrate, miners_active, created_at
         FROM pool_stats
         WHERE created_at > NOW() - INTERVAL '1 hour' * $1
         ORDER BY created_at ASC`,
        [hours]
      );

      res.json({ history: result.rows });
    } catch (err) {
      log.error({ err: err.message }, 'Pool hashrate history error');
      res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
    }
  });

  // ── Extended Multi-Coin Routes ──
  registerExtendedRoutes(app, deps);

  // ── Security Routes (v0.4.0) ──
  if (deps.securityManager) {
    registerSecurityRoutes(app, deps);
  }

  // ── Pool Optimization Routes (v0.4.0) ──
  registerPoolRoutes(app, deps);

  // ── Fleet Management Routes (v0.5.1) ──
  registerFleetRoutes(app, deps);

  // ── Dashboard Routes (v0.7.0) ──
  registerDashboardRoutes(app, deps);

  // ── 404 ──
  app.use((req, res) => {
    res.status(API.errors.NOT_FOUND.status).json(API.errors.NOT_FOUND);
  });

  // ── Error handler ──
  app.use((err, req, res, _next) => {
    log.error({ err: err.message, path: req.path }, 'Unhandled API error');
    res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
  });

  return app;
}

module.exports = { createApiServer };
