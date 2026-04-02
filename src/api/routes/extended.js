const { API } = require('../../ux/copy');
/**
 * LUXXPOOL — Extended API Routes
 * Multi-coin, aux chain stats, solo mining, banning, wallet registration
 */

const { createLogger } = require('../../utils/logger');
const { SCRYPT_COINS } = require('../../config/coins');
const HashrateEstimator = require('../../monitoring/hashrateEstimator');

const log = createLogger('api:ext');

/**
 * Register extended routes on the Express app
 * @param {import('express').Express} app
 * @param {object} deps
 */
function registerExtendedRoutes(app, deps) {
  const { db, redis, auxPowEngine, auxRpcClients, soloServer, hashrateEstimator, banningManager, blockWatcher } = deps;

  // ═══════════════════════════════════════════════════════
  // MULTI-COIN: Supported coins list
  // ═══════════════════════════════════════════════════════

  app.get('/api/v1/coins', (req, res) => {
    const coins = Object.entries(SCRYPT_COINS).map(([sym, conf]) => ({
      symbol: sym,
      name: conf.name,
      role: conf.role,
      enabled: conf.enabled,
      blockTime: conf.blockTime,
      blockReward: conf.blockReward,
      payoutThreshold: conf.payoutThreshold,
    }));
    res.json({ coins });
  });

  // ═══════════════════════════════════════════════════════
  // AUX CHAIN STATUS
  // ═══════════════════════════════════════════════════════

  app.get('/api/v1/aux/status', (req, res) => {
    if (!auxPowEngine) return res.json({ chains: {} });

    const stats = auxPowEngine.getStats();
    res.json({
      activeChains: auxPowEngine.getActiveChainCount(),
      chains: stats,
    });
  });

  app.get('/api/v1/aux/:coin/blocks', async (req, res) => {
    const coin = req.params.coin.toUpperCase();
    const limit = Math.min(parseInt(req.query.limit || '50'), 100);

    try {
      const result = await db.query(
        'SELECT * FROM aux_blocks WHERE coin = $1 ORDER BY created_at DESC LIMIT $2',
        [coin, limit]
      );
      res.json({ coin, blocks: result.rows });
    } catch (err) {
      log.error({ err: err.message }, 'Aux blocks query error');
      res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
    }
  });

  // ═══════════════════════════════════════════════════════
  // SOLO MINING
  // ═══════════════════════════════════════════════════════

  app.get('/api/v1/solo/miners', (req, res) => {
    if (!soloServer) return res.json({ miners: [], count: 0 });

    const miners = soloServer.getClients()
      .filter(c => c.authorized)
      .map(c => c.toJSON());

    res.json({ count: miners.length, miners });
  });

  app.get('/api/v1/solo/blocks', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 100);

    try {
      const result = await db.query(
        'SELECT * FROM solo_blocks ORDER BY created_at DESC LIMIT $1',
        [limit]
      );
      res.json({ blocks: result.rows });
    } catch (err) {
      res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
    }
  });

  // ═══════════════════════════════════════════════════════
  // WALLET REGISTRATION (miners register aux coin addresses)
  // ═══════════════════════════════════════════════════════

  app.post('/api/v1/miner/:address/wallets', async (req, res) => {
    const { address } = req.params;
    const { coin, coinAddress } = req.body;

    if (!coin || !coinAddress) {
      return res.status(400).json({ error: API.validation.COIN_AND_ADDRESS, code: 'VALIDATION_ERROR' });
    }

    const upperCoin = coin.toUpperCase();
    if (!SCRYPT_COINS[upperCoin]) {
      return res.status(400).json({ error: `Unknown coin: ${coin}` });
    }

    // Validate coin address format (basic length + charset check)
    if (!coinAddress || coinAddress.length < 20 || coinAddress.length > 64 || !/^[a-zA-Z0-9]+$/.test(coinAddress)) {
      return res.status(400).json({ error: 'Invalid coin address format', code: 'VALIDATION_ERROR' });
    }

    try {
      await db.query(
        `INSERT INTO miner_wallets (miner_address, coin, coin_address, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (miner_address, coin) DO UPDATE SET coin_address = $3, updated_at = NOW()`,
        [address, upperCoin, coinAddress]
      );

      res.json({ success: true, coin: upperCoin, coinAddress });
    } catch (err) {
      log.error({ err: err.message }, 'Wallet registration error');
      res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
    }
  });

  app.get('/api/v1/miner/:address/wallets', async (req, res) => {
    const { address } = req.params;

    try {
      const result = await db.query(
        'SELECT coin, coin_address, updated_at FROM miner_wallets WHERE miner_address = $1',
        [address]
      );

      const wallets = {};
      for (const row of result.rows) {
        wallets[row.coin] = { address: row.coin_address, updatedAt: row.updated_at };
      }

      // List aux coins that still need wallet registration
      const registeredCoins = new Set(result.rows.map(r => r.coin));
      const unregistered = Object.entries(SCRYPT_COINS)
        .filter(([sym, conf]) => conf.enabled && conf.role === 'auxiliary' && !registeredCoins.has(sym))
        .map(([sym]) => sym);

      res.json({ address, wallets, unregistered });
    } catch (err) {
      res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
    }
  });

  // Bulk wallet registration — register multiple coin addresses at once
  app.post('/api/v1/miner/:address/wallets/bulk', async (req, res) => {
    const { address } = req.params;
    const { wallets } = req.body; // expects { DOGE: "D...", BELLS: "B...", ... }

    if (!wallets || typeof wallets !== 'object' || Array.isArray(wallets)) {
      return res.status(400).json({ error: 'Body must contain { wallets: { COIN: "address", ... } }' });
    }

    const results = { registered: [], errors: [] };

    for (const [coin, coinAddress] of Object.entries(wallets)) {
      const upperCoin = coin.toUpperCase();

      if (!SCRYPT_COINS[upperCoin]) {
        results.errors.push({ coin: upperCoin, error: `Unknown coin: ${upperCoin}` });
        continue;
      }
      if (!coinAddress || coinAddress.length < 20 || coinAddress.length > 64 || !/^[a-zA-Z0-9]+$/.test(coinAddress)) {
        results.errors.push({ coin: upperCoin, error: 'Invalid address format' });
        continue;
      }

      try {
        await db.query(
          `INSERT INTO miner_wallets (miner_address, coin, coin_address, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (miner_address, coin) DO UPDATE SET coin_address = $3, updated_at = NOW()`,
          [address, upperCoin, coinAddress]
        );
        results.registered.push({ coin: upperCoin, address: coinAddress });
      } catch (err) {
        results.errors.push({ coin: upperCoin, error: err.message });
      }
    }

    res.json(results);
  });

  // Delete a registered wallet for a specific coin
  app.delete('/api/v1/miner/:address/wallets/:coin', async (req, res) => {
    const { address, coin } = req.params;
    const upperCoin = coin.toUpperCase();

    try {
      const result = await db.query(
        'DELETE FROM miner_wallets WHERE miner_address = $1 AND coin = $2',
        [address, upperCoin]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: `No wallet registered for ${upperCoin}` });
      }

      res.json({ success: true, coin: upperCoin, message: 'Wallet removed' });
    } catch (err) {
      res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
    }
  });

  // ═══════════════════════════════════════════════════════
  // HASHRATE (enhanced)
  // ═══════════════════════════════════════════════════════

  app.get('/api/v1/pool/hashrate/live', (req, res) => {
    if (!hashrateEstimator) return res.json({ hashrate: 0, formatted: '0 H/s' });

    const hashrate = hashrateEstimator.getPoolHashrate();
    res.json({
      hashrate,
      formatted: HashrateEstimator.formatHashrate(hashrate),
    });
  });

  app.get('/api/v1/miner/:address/hashrate/live', (req, res) => {
    if (!hashrateEstimator) return res.json({ hashrate: 0 });

    const hashrate = hashrateEstimator.getMinerHashrate(req.params.address);
    res.json({
      address: req.params.address,
      hashrate,
      formatted: HashrateEstimator.formatHashrate(hashrate),
    });
  });

  // ═══════════════════════════════════════════════════════
  // BANNING
  // ═══════════════════════════════════════════════════════

  app.get('/api/v1/admin/bans', (req, res) => {
    if (!banningManager) return res.json({ bans: [] });
    res.json({
      count: banningManager.getBannedCount(),
      bans: banningManager.getBannedList(),
    });
  });

  // ═══════════════════════════════════════════════════════
  // BLOCK WATCHER STATUS
  // ═══════════════════════════════════════════════════════

  app.get('/api/v1/blocks/pending', async (req, res) => {
    if (!blockWatcher) return res.json({ pending: [] });

    const summary = await blockWatcher.getPendingSummary();
    res.json({ pending: summary });
  });

  // ═══════════════════════════════════════════════════════
  // COMBINED POOL STATS (full overview)
  // ═══════════════════════════════════════════════════════

  app.get('/api/v1/pool/overview', async (req, res) => {
    try {
      const [poolHr, auxStatus, pendingBlocks, blocksResult, paymentsResult] = await Promise.all([
        Promise.resolve(hashrateEstimator ? hashrateEstimator.getPoolHashrate() : 0),
        Promise.resolve(auxPowEngine ? auxPowEngine.getStats() : {}),
        blockWatcher ? blockWatcher.getPendingSummary() : [],
        db.query('SELECT COUNT(*) as total, SUM(CASE WHEN confirmed THEN 1 ELSE 0 END) as confirmed FROM blocks'),
        db.query('SELECT COUNT(*) as total, COALESCE(SUM(amount),0) as total_paid FROM payments WHERE status = $1', ['sent']),
      ]);

      res.json({
        pool: {
          hashrate: poolHr,
          hashrateFormatted: HashrateEstimator.formatHashrate(poolHr),
          pendingBlocks,
        },
        blocks: blocksResult.rows[0],
        payments: paymentsResult.rows[0],
        auxChains: auxStatus,
        coins: Object.keys(SCRYPT_COINS).filter(s => SCRYPT_COINS[s].enabled),
      });
    } catch (err) {
      log.error({ err: err.message }, 'Overview error');
      res.status(API.errors.INTERNAL.status).json(API.errors.INTERNAL);
    }
  });
}

module.exports = { registerExtendedRoutes };
