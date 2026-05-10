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
const poolLogger = require('../logging/poolLogger');
const minerRegistry = require('../pool/minerRegistry');
const { registerExtendedRoutes } = require('./routes/extended');
const { registerSecurityRoutes } = require('./routes/security');
const { registerPoolRoutes } = require('./routes/pool');
const { registerFleetRoutes } = require('./routes/fleet');
const { registerDashboardRoutes } = require('./routes/dashboard');
const { isAdminRequest } = require('./middleware/adminAuth');
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
  app.use(express.json({ limit: '10kb' }));

  const limiter = rateLimit({
    windowMs: config.api.rateLimitWindow,
    max: config.api.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/', limiter);

  // Per-address Redis-backed limiter for /api/v1/miner/:address* —
  // the global limiter is per-IP, so a single attacker can iterate
  // through addresses to enumerate active miners and pound the DB.
  // Limit: 30 requests per address per 60s window. Fails open if Redis
  // is unavailable so legitimate users are never blocked by a Redis
  // outage.
  async function perAddressLimit(req, res, next) {
    const addr = req.params.address;
    if (!addr) return next();
    try {
      const key = `ratelimit:miner:${addr}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, 60);
      if (count > 30) {
        return res.status(429).json({ error: 'Too many lookups for this address', code: 'RATE_LIMIT' });
      }
    } catch (err) {
      log.warn({ err: err.message }, 'Address rate limiter unavailable — allowing through');
    }
    next();
  }

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

  app.get('/api/v1/miner/:address', perAddressLimit, async (req, res) => {
    const { address } = req.params;

    // Cached not-found responses absorb enumeration probes without
    // hitting Postgres on every guess.
    try {
      const cached = await redis.get(`miner-cache:notfound:${address}`);
      if (cached) {
        return res.status(API.errors.MINER_NOT_FOUND.status).json(API.errors.MINER_NOT_FOUND);
      }
    } catch (err) {
      log.debug({ err: err.message }, 'miner-not-found cache lookup failed');
    }

    try {
      // Miner info
      const minerResult = await db.query(
        'SELECT * FROM miners WHERE address = $1',
        [address]
      );

      if (minerResult.rows.length === 0) {
        redis.setex(`miner-cache:notfound:${address}`, 60, '1')
          .catch(err => log.debug({ err: err.message }, 'miner-not-found cache set failed'));
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
  app.get('/api/v1/miner/:address/hashrate', perAddressLimit, async (req, res) => {
    const { address } = req.params;
    // Clamp to 1..720 (30 days). Without this an attacker could request
    // ?hours=999999999 and force NOW() - INTERVAL '... hour' to enumerate
    // every row in pool_stats / miner_hashrate.
    const hours = Math.min(Math.max(parseInt(req.query.hours || '24', 10) || 24, 1), 720);

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

    const isAdmin = isAdminRequest(req);

    const miners = stratumServer.getClients()
      .filter(c => c.authorized)
      .map(c => {
        const j = c.toJSON();
        if (isAdmin) return j;
        // Public response: strip identifying fields. The public endpoint
        // is unauthenticated, so anyone could otherwise enumerate fleet
        // and miner IPs.
        delete j.ip;
        delete j.id;
        if (typeof j.worker === 'string' && j.worker.length > 12) {
          j.worker = j.worker.slice(0, 10) + '...';
        }
        if (typeof j.address === 'string' && j.address.length > 14) {
          j.address = j.address.slice(0, 6) + '...' + j.address.slice(-4);
        }
        return j;
      });

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
    // Clamp to 1..720 (30 days). Without this an attacker could request
    // ?hours=999999999 and force NOW() - INTERVAL '... hour' to enumerate
    // every row in pool_stats / miner_hashrate.
    const hours = Math.min(Math.max(parseInt(req.query.hours || '24', 10) || 24, 1), 720);

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

  // ── Security Routes ──
  if (deps.securityEngine) {
    registerSecurityRoutes(app, deps);
  }

  // ── Pool Optimization Routes (v0.4.0) ──
  registerPoolRoutes(app, deps);

  // ── Fleet Management Routes (v0.5.1) ──
  registerFleetRoutes(app, deps);

  // ── Dashboard Routes (v0.7.0) ──
  registerDashboardRoutes(app, deps);

  // ── v0.8.2: ASIC model catalog ──
  app.get('/api/v1/models', (req, res) => {
    const models = minerRegistry.listModels();
    res.json({ count: models.length, models });
  });

  // ── 404 ──
  app.use((req, res) => {
    res.status(API.errors.NOT_FOUND.status).json(API.errors.NOT_FOUND);
  });

  // ── Error handler ──
  app.use((err, req, res, _next) => {
    log.error({ err: err.message, path: req.path }, 'Unhandled API error');
    try { poolLogger.emit('SYS_008', { route: req.path, error: err.message }); } catch {}
    res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
  });

  return app;
}

module.exports = { createApiServer };
