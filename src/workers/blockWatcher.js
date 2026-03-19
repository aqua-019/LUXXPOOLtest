/**
 * LUXXPOOL — Block Confirmation Watcher
 * Monitors found blocks across LTC and all aux chains,
 * tracks confirmation counts, detects orphans, and triggers
 * payout eligibility when maturity is reached.
 */

const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');
const { SCRYPT_COINS } = require('../../config/coins');

const log = createLogger('blockwatcher');

class BlockConfirmationWatcher extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.db - Database query interface
   * @param {object} deps.rpcClients - Map of symbol → RpcClient
   * @param {number} intervalMs - Check interval (default 60s)
   */
  constructor(deps, intervalMs = 60000) {
    super();
    this.db = deps.db;
    this.rpcClients = deps.rpcClients; // { LTC: rpc, DOGE: rpc, ... }
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    log.info({ interval: this.intervalMs / 1000 }, 'Block confirmation watcher started');
    this.timer = setInterval(() => this.checkBlocks(), this.intervalMs);
    this.checkBlocks(); // Immediate first check
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    log.info('Block confirmation watcher stopped');
  }

  /**
   * Check all unconfirmed blocks across all coin types
   */
  async checkBlocks() {
    try {
      // Get all unconfirmed, non-orphaned blocks
      const result = await this.db.query(
        `SELECT * FROM blocks
         WHERE confirmed = false AND orphaned = false
         ORDER BY created_at ASC`
      );

      if (result.rows.length === 0) return;

      log.debug({ pending: result.rows.length }, 'Checking pending blocks');

      for (const block of result.rows) {
        await this._checkBlock(block);
      }
    } catch (err) {
      log.error({ err: err.message }, 'Block watcher cycle error');
    }
  }

  /**
   * Check a single block's confirmation status
   */
  async _checkBlock(block) {
    const coin = block.coin || 'LTC';
    const coinConfig = SCRYPT_COINS[coin];
    const rpc = this.rpcClients[coin];

    if (!rpc) {
      log.warn({ coin, height: block.height }, 'No RPC client for coin');
      return;
    }

    if (!coinConfig) return;

    const requiredConfs = coinConfig.confirmations || 100;

    try {
      // Get the block hash at this height from the main chain
      let chainBlockHash;
      try {
        chainBlockHash = await rpc.call('getblockhash', [block.height]);
      } catch {
        // Height doesn't exist yet (chain hasn't reached it)
        return;
      }

      const chainBlock = await rpc.getBlock(chainBlockHash);

      if (!chainBlock) {
        log.warn({ coin, height: block.height }, 'Block not found on chain');
        return;
      }

      const confirmations = chainBlock.confirmations || 0;

      // Update confirmation count in database
      await this.db.query(
        'UPDATE blocks SET confirmations = $1, hash = $2 WHERE id = $3',
        [confirmations, chainBlockHash, block.id]
      );

      // Check if block was orphaned (hash mismatch)
      if (block.hash && block.hash !== chainBlockHash && block.hash !== '' && block.hash.length > 10) {
        log.warn({
          coin,
          height: block.height,
          expected: block.hash?.substring(0, 16),
          actual: chainBlockHash.substring(0, 16),
        }, '⚠️  Block ORPHANED — chain hash mismatch');

        await this.db.query(
          'UPDATE blocks SET orphaned = true WHERE id = $1',
          [block.id]
        );

        this.emit('blockOrphaned', block, coin);
        return;
      }

      // Check if matured
      if (confirmations >= requiredConfs && !block.confirmed) {
        log.info({
          coin,
          height: block.height,
          confirmations,
          reward: block.reward,
        }, `✅ Block CONFIRMED — ready for payout`);

        await this.db.query(
          'UPDATE blocks SET confirmed = true, confirmations = $1 WHERE id = $2',
          [confirmations, block.id]
        );

        this.emit('blockConfirmed', block, coin, confirmations);
      } else if (confirmations > 0) {
        log.debug({
          coin,
          height: block.height,
          confirmations,
          required: requiredConfs,
          remaining: requiredConfs - confirmations,
        }, 'Block maturing');
      }

    } catch (err) {
      log.error({
        coin,
        height: block.height,
        err: err.message,
      }, 'Block confirmation check failed');
    }
  }

  /**
   * Get summary of all pending blocks
   */
  async getPendingSummary() {
    try {
      const result = await this.db.query(
        `SELECT coin, COUNT(*) as count,
                MIN(confirmations) as min_confs,
                MAX(confirmations) as max_confs
         FROM blocks
         WHERE confirmed = false AND orphaned = false
         GROUP BY coin`
      );
      return result.rows;
    } catch {
      return [];
    }
  }
}

module.exports = BlockConfirmationWatcher;
