const { API } = require('../../ux/copy');
/**
 * LUXXPOOL — Pool Optimization Routes
 * Health monitoring, worker details, profit estimation, diagnostics
 */

const ProfitEstimator = require('../../utils/profitEstimator');
const HashrateEstimator = require('../../monitoring/hashrateEstimator');
const { createLogger } = require('../../utils/logger');
const log = createLogger('api:pool');

function registerPoolRoutes(app, deps) {
  const { healthMonitor, workerTracker, hashrateEstimator, rpcClient, stratumServer, soloServer, securityEngine, banningManager } = deps;

  // Full system health
  app.get('/api/v1/health/full', (req, res) => {
    if (!healthMonitor) return res.json({ status: 'monitor not initialized' });
    const status = healthMonitor.getStatus();
    status.healthy = healthMonitor.isHealthy();
    res.json(status);
  });

  // Worker-level details
  app.get('/api/v1/workers', (req, res) => {
    if (!workerTracker) {
      // Fallback to stratum client data
      const pool = stratumServer ? stratumServer.getClients().filter(c => c.authorized).map(c => c.toJSON()) : [];
      const solo = soloServer ? soloServer.getClients().filter(c => c.authorized).map(c => ({ ...c.toJSON(), mode: 'solo' })) : [];
      return res.json({ workers: [...pool, ...solo] });
    }
    res.json({ workers: workerTracker.getAllWorkers() });
  });

  // Pool stale rate
  app.get('/api/v1/pool/stale-rate', (req, res) => {
    if (!workerTracker) return res.json({ staleRate: 0 });
    res.json({
      staleRatePct: workerTracker.getPoolStaleRate().toFixed(2),
      recommendedDifficulty: workerTracker.calculateDifficultyFloor(
        hashrateEstimator ? hashrateEstimator.getPoolHashrate() : 0,
        stratumServer ? stratumServer.clients.size : 0
      ),
    });
  });

  // Profit estimator
  app.get('/api/v1/estimate/profit', async (req, res) => {
    const hashrate = parseFloat(req.query.hashrate || '0'); // H/s
    const fee = parseFloat(req.query.fee || '0.02');

    if (!isFinite(hashrate) || hashrate < 0 || !isFinite(fee) || fee < 0 || fee > 1) {
      return res.status(400).json({ error: 'Invalid hashrate or fee parameter' });
    }

    try {
      const miningInfo = await rpcClient.getMiningInfo();
      const poolEstimate = ProfitEstimator.estimateDaily(hashrate, miningInfo.difficulty, fee);
      const soloEstimate = ProfitEstimator.estimateSoloBlockTime(hashrate, miningInfo.difficulty);

      res.json({
        pool: poolEstimate,
        solo: soloEstimate,
        networkDifficulty: miningInfo.difficulty,
        networkHashrate: miningInfo.networkhashps,
      });
    } catch (err) {
      log.error({ err: err.message }, 'Profit estimation error');
      res.status(API.errors.DAEMON_OFFLINE.status).json(API.errors.DAEMON_OFFLINE);
    }
  });

  // Pre-built estimate for common miners
  app.get('/api/v1/estimate/miners', async (req, res) => {
    try {
      const miningInfo = await rpcClient.getMiningInfo();
      const diff = miningInfo.difficulty;

      const miners = [
        { name: 'Antminer L9', hashrate: 17e9 },
        { name: 'Antminer L7', hashrate: 9.5e9 },
        { name: 'ElphaPex DG2', hashrate: 17e9 },
        { name: 'VOLCMINER D1', hashrate: 11e9 },
      ];

      const estimates = miners.map(m => ({
        miner: m.name,
        hashrate: HashrateEstimator.formatHashrate(m.hashrate),
        pool: ProfitEstimator.estimateDaily(m.hashrate, diff, 0.02),
        solo: ProfitEstimator.estimateSoloBlockTime(m.hashrate, diff),
      }));

      res.json({ difficulty: diff, estimates });
    } catch (err) {
      res.status(API.errors.DAEMON_OFFLINE.status).json(API.errors.DAEMON_OFFLINE);
    }
  });

  // Diagnostics: full pool state
  app.get('/api/v1/diagnostics', async (req, res) => {
    res.json({
      version: '0.7.2',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      stratum: {
        pool: { clients: stratumServer?.clients.size || 0, totalConnections: stratumServer?.stats.totalConnections || 0, blocksFound: stratumServer?.stats.blocksFound || 0 },
        solo: { clients: soloServer?.clients.size || 0, totalConnections: soloServer?.stats.totalConnections || 0 },
      },
      security: securityEngine ? await securityEngine.getStatus() : 'not active',
      banning: { bannedCount: banningManager?.getBannedCount() || 0 },
      hashrate: hashrateEstimator ? HashrateEstimator.formatHashrate(hashrateEstimator.getPoolHashrate()) : '0',
      health: healthMonitor ? healthMonitor.getStatus() : 'not active',
    });
  });
}

module.exports = { registerPoolRoutes };
