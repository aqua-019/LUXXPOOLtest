/**
 * LUXXPOOL — Stats Collector
 * Periodically snapshots pool and miner hashrates to database
 */

const { createLogger } = require('../utils/logger');

const log = createLogger('stats');

class StatsCollector {
  /**
   * @param {object} deps - { db, redis, stratumServer, rpcClient }
   * @param {number} intervalMs - Collection interval (default 60s)
   */
  constructor(deps, intervalMs = 60000) {
    this.db = deps.db;
    this.redis = deps.redis;
    this.stratum = deps.stratumServer;
    this.rpc = deps.rpcClient;
    this.interval = intervalMs;
    this.timer = null;
  }

  start() {
    log.info({ interval: this.interval / 1000 }, 'Stats collector started');
    this.timer = setInterval(() => this.collect(), this.interval);
    this.collect(); // immediate first collection
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    log.info('Stats collector stopped');
  }

  async collect() {
    try {
      const poolHashrate = this.stratum ? this.stratum.getPoolHashrate() : 0;
      const activeMiners = this.stratum ? this.stratum.clients.size : 0;

      let networkDiff = 0;
      let networkHashrate = 0;
      let blockHeight = 0;

      try {
        const miningInfo = await this.rpc.getMiningInfo();
        networkDiff = miningInfo.difficulty;
        networkHashrate = miningInfo.networkhashps;
        blockHeight = miningInfo.blocks;
      } catch (err) { log.debug({ err: err.message }, 'Mining info RPC failed'); }

      // Pool stats snapshot
      await this.db.query(
        `INSERT INTO pool_stats (hashrate, miners_active, network_diff, network_hashrate, block_height, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [poolHashrate, activeMiners, networkDiff, networkHashrate, blockHeight]
      );

      // Per-miner hashrate snapshots
      if (this.stratum) {
        const minerHashrates = new Map();

        for (const [, client] of this.stratum.clients) {
          if (!client.authorized || !client.minerAddress) continue;

          const current = minerHashrates.get(client.minerAddress) || { hashrate: 0, workers: 0 };
          current.hashrate += client.hashrate || 0;
          current.workers += 1;
          minerHashrates.set(client.minerAddress, current);
        }

        for (const [address, data] of minerHashrates) {
          await this.db.query(
            `INSERT INTO miner_hashrate (address, hashrate, worker_count, created_at)
             VALUES ($1, $2, $3, NOW())`,
            [address, data.hashrate, data.workers]
          );

          // Update miner last_seen
          await this.db.query(
            `INSERT INTO miners (address, last_seen)
             VALUES ($1, NOW())
             ON CONFLICT (address) DO UPDATE SET last_seen = NOW(), is_active = true`,
            [address]
          );
        }
      }

      log.debug({
        poolHashrate,
        activeMiners,
        networkDiff,
        blockHeight,
      }, 'Stats snapshot recorded');

    } catch (err) {
      log.error({ err: err.message }, 'Stats collection error');
    }
  }
}

module.exports = StatsCollector;
