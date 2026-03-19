/**
 * LUXXPOOL — Payment Processor
 * Handles PPLNS payout calculations and batch Litecoin payments
 */

const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');

const log = createLogger('payments');

class PaymentProcessor extends EventEmitter {
  /**
   * @param {import('../blockchain/rpcClient')} rpcClient
   * @param {object} db - Database query interface
   * @param {object} redis - Redis client
   * @param {object} config - Payment configuration
   */
  constructor(rpcClient, db, redis, config, redisKeys) {
    super();
    this.rpc = rpcClient;
    this.db = db;
    this.redis = redis;
    this.config = config;
    this.keys = redisKeys;

    this.processing = false;
    this.interval = null;
  }

  /**
   * Start the payment processing loop
   */
  start() {
    const intervalMs = (this.config.interval || 600) * 1000;
    log.info({
      interval: this.config.interval,
      minPayout: this.config.minPayout,
      scheme: this.config.scheme,
    }, 'Payment processor started');

    this.interval = setInterval(() => this.processPayments(), intervalMs);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    log.info('Payment processor stopped');
  }

  /**
   * Main payment processing cycle
   */
  async processPayments() {
    if (this.processing) {
      log.warn('Payment processing already in progress, skipping');
      return;
    }

    this.processing = true;

    try {
      // Step 1: Check for confirmed blocks ready for payout
      const confirmedBlocks = await this._getConfirmedBlocks();
      if (confirmedBlocks.length === 0) {
        log.debug('No confirmed blocks pending payout');
        return;
      }

      for (const block of confirmedBlocks) {
        log.info({ height: block.height, reward: block.reward }, 'Processing payouts for block');

        // Step 2: Calculate shares per miner (PPLNS)
        const shares = await this._calculatePPLNS(block);
        if (Object.keys(shares).length === 0) {
          log.warn({ height: block.height }, 'No shares found for block');
          continue;
        }

        // Step 3: Calculate payment amounts
        const payments = this._calculatePayments(block, shares);

        // Step 4: Filter by minimum payout
        const eligiblePayments = {};
        for (const [address, amount] of Object.entries(payments)) {
          if (amount >= this.config.minPayout) {
            eligiblePayments[address] = amount;
          } else {
            // Accumulate for future payout
            await this._accumulateBalance(address, amount);
          }
        }

        // Step 5: Execute batch payment
        if (Object.keys(eligiblePayments).length > 0) {
          await this._executeBatchPayment(eligiblePayments, block);
        }

        // Step 6: Mark round as paid
        await this._markRoundPaid(block);
      }

    } catch (err) {
      log.error({ err: err.message }, 'Payment processing error');
    } finally {
      this.processing = false;
    }
  }

  /**
   * Get blocks with enough confirmations for payout
   */
  async _getConfirmedBlocks() {
    const REQUIRED_CONFIRMATIONS = 100; // Litecoin coinbase maturity

    try {
      const currentHeight = await this.rpc.getBlockCount();

      const result = await this.db.query(
        `SELECT * FROM blocks
         WHERE confirmed = false AND orphaned = false AND coin = 'LTC'
         AND height <= $1
         ORDER BY height ASC`,
        [currentHeight - REQUIRED_CONFIRMATIONS]
      );

      // Verify each block is still in the main chain
      const confirmed = [];
      for (const block of result.rows) {
        try {
          const chainBlock = await this.rpc.getBlock(
            await this.rpc.call('getblockhash', [block.height])
          );

          if (chainBlock && chainBlock.confirmations >= REQUIRED_CONFIRMATIONS) {
            confirmed.push(block);
            await this.db.query(
              'UPDATE blocks SET confirmed = true, confirmations = $1 WHERE id = $2',
              [chainBlock.confirmations, block.id]
            );
          } else {
            // Block was orphaned
            await this.db.query(
              'UPDATE blocks SET orphaned = true WHERE id = $1',
              [block.id]
            );
            log.warn({ height: block.height }, 'Block orphaned');
          }
        } catch (err) {
          log.error({ height: block.height, err: err.message }, 'Block verification failed');
        }
      }

      return confirmed;
    } catch (err) {
      log.error({ err: err.message }, 'Failed to get confirmed blocks');
      return [];
    }
  }

  /**
   * Calculate PPLNS share distribution for a block
   * @param {object} block
   * @returns {Object<string, number>} address → total share difficulty
   */
  async _calculatePPLNS(block) {
    const windowBlocks = this.config.pplnsWindow || 2;
    const startHeight = Math.max(0, block.height - windowBlocks);

    try {
      const result = await this.db.query(
        `SELECT address, SUM(difficulty) as total_diff
         FROM shares
         WHERE height >= $1 AND height <= $2
         GROUP BY address`,
        [startHeight, block.height]
      );

      const shares = {};
      for (const row of result.rows) {
        shares[row.address] = parseFloat(row.total_diff);
      }

      return shares;
    } catch (err) {
      log.error({ err: err.message }, 'PPLNS calculation failed');
      return {};
    }
  }

  /**
   * Calculate payment amounts from share distribution.
   * Fleet miners pay 0% fee. Public miners pay the pool fee.
   * Fee is calculated per-miner, not on the whole block.
   */
  _calculatePayments(block, shares) {
    const totalShares = Object.values(shares).reduce((a, b) => a + b, 0);
    if (totalShares === 0) return {};

    const rewardLTC = block.reward / 1e8;
    const poolFeeRate = this.config.poolFee || 0.02;
    const fleetAddresses = this.config.fleetAddresses || new Set();

    let totalFee = 0;
    const payments = {};

    for (const [address, minerShares] of Object.entries(shares)) {
      const proportion = minerShares / totalShares;
      const gross = rewardLTC * proportion;

      // Fleet miners: zero fee. Public miners: standard fee.
      const isFleet = fleetAddresses.has(address);
      const fee = isFleet ? 0 : gross * poolFeeRate;
      const net = parseFloat((gross - fee).toFixed(8));

      totalFee += fee;
      if (net > 0) payments[address] = net;
    }

    log.info({
      totalShares,
      miners: Object.keys(payments).length,
      reward: rewardLTC,
      totalFee: parseFloat(totalFee.toFixed(8)),
      fleetMiners: [...fleetAddresses].filter(a => shares[a]).length,
    }, 'Payment calculation complete (fleet-aware)');

    return payments;
  }

  /**
   * Execute a batch sendmany payment
   */
  async _executeBatchPayment(payments, block) {
    try {
      // Batch payments in groups
      const addresses = Object.keys(payments);
      const batchSize = this.config.maxBatch || 100;

      for (let i = 0; i < addresses.length; i += batchSize) {
        const batch = {};
        const batchAddresses = addresses.slice(i, i + batchSize);

        for (const addr of batchAddresses) {
          batch[addr] = payments[addr];
        }

        log.info({
          batchSize: batchAddresses.length,
          totalAmount: Object.values(batch).reduce((a, b) => a + b, 0),
        }, 'Sending batch payment');

        const txid = await this.rpc.sendMany('', batch);

        log.info({ txid, batchSize: batchAddresses.length }, 'Batch payment sent');

        // Record payments in database
        for (const [address, amount] of Object.entries(batch)) {
          await this.db.query(
            `INSERT INTO payments (address, amount, txid, coin, status, block_height, sent_at)
             VALUES ($1, $2, $3, 'LTC', 'sent', $4, NOW())`,
            [address, amount, txid, block.height]
          );

          // Update miner total_paid
          await this.db.query(
            'UPDATE miners SET total_paid = total_paid + $1 WHERE address = $2',
            [amount, address]
          );
        }

        this.emit('paymentSent', { txid, payments: batch, block });
      }

    } catch (err) {
      log.error({ err: err.message }, 'Batch payment execution failed');

      // Record failed payments
      for (const [address, amount] of Object.entries(payments)) {
        await this.db.query(
          `INSERT INTO payments (address, amount, coin, status, block_height)
           VALUES ($1, $2, 'LTC', 'failed', $3)`,
          [address, amount, block.height]
        );
      }
    }
  }

  /**
   * Accumulate small balance for future payout
   */
  async _accumulateBalance(address, amount) {
    try {
      await this.redis.incrbyfloat(this.keys.pendingBalance(address), amount);
    } catch (err) {
      log.error({ err: err.message, address }, 'Balance accumulation failed');
    }
  }

  /**
   * Mark a mining round as paid
   */
  async _markRoundPaid(block) {
    try {
      await this.db.query(
        `UPDATE rounds SET status = 'paid', paid_at = NOW() WHERE height = $1`,
        [block.height]
      );
    } catch (err) {
      log.error({ err: err.message }, 'Failed to mark round as paid');
    }
  }
}

module.exports = PaymentProcessor;
