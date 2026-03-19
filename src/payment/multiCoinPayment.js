/**
 * LUXXPOOL — Multi-Coin Payment Processor
 * Handles payouts for LTC and all merged-mined auxiliary coins.
 * Each coin has its own payout threshold, maturity period,
 * and RPC client for sending transactions.
 */

const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');
const { SCRYPT_COINS } = require('../../config/coins');

const log = createLogger('multicoin-pay');

class MultiCoinPaymentProcessor extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.rpcClients - Map of symbol → RpcClient
   * @param {object} deps.db - Database query interface
   * @param {object} deps.redis - Redis client
   * @param {object} config - Payment configuration
   */
  constructor(deps, config) {
    super();
    this.rpcClients = deps.rpcClients;
    this.db = deps.db;
    this.redis = deps.redis;
    this.config = config;

    this.processing = false;
    this.timer = null;
  }

  start() {
    const intervalMs = (this.config.interval || 600) * 1000;
    log.info({
      interval: this.config.interval,
      coins: Object.keys(this.rpcClients),
    }, 'Multi-coin payment processor started');

    this.timer = setInterval(() => this.processAll(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    log.info('Multi-coin payment processor stopped');
  }

  /**
   * Process payments for all coins
   */
  async processAll() {
    if (this.processing) return;
    this.processing = true;

    try {
      for (const [symbol, rpc] of Object.entries(this.rpcClients)) {
        const coinConfig = SCRYPT_COINS[symbol];
        if (!coinConfig || !coinConfig.enabled) continue;

        try {
          await this._processForCoin(symbol, rpc, coinConfig);
        } catch (err) {
          log.error({ coin: symbol, err: err.message }, 'Payment processing failed for coin');
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process payments for a specific coin
   */
  async _processForCoin(symbol, rpc, coinConfig) {
    const requiredConfs = coinConfig.confirmations || 100;

    // Get confirmed blocks for this coin
    const result = await this.db.query(
      `SELECT * FROM blocks
       WHERE coin = $1 AND confirmed = true AND orphaned = false
       AND id NOT IN (
         SELECT block_id FROM rounds WHERE status = 'paid' AND block_id IS NOT NULL
       )
       ORDER BY height ASC
       LIMIT 10`,
      [symbol]
    );

    if (result.rows.length === 0) return;

    for (const block of result.rows) {
      log.info({ coin: symbol, height: block.height }, `Processing ${symbol} payouts`);

      // Calculate share distribution (PPLNS across this round)
      const shares = await this._getShareDistribution(block);
      if (Object.keys(shares).length === 0) continue;

      // Calculate amounts
      const payments = this._calculatePayments(block, shares, symbol);

      // Get miner-specific coin addresses from their registered wallets
      const eligiblePayments = {};
      const threshold = coinConfig.payoutThreshold || 0;

      for (const [minerAddress, amount] of Object.entries(payments)) {
        // Get this miner's specific wallet for this coin
        const coinAddress = await this._getMinerCoinAddress(minerAddress, symbol);

        if (!coinAddress) {
          // Miner hasn't registered a wallet for this coin — accumulate
          await this._accumulate(minerAddress, symbol, amount);
          continue;
        }

        // Check payout threshold (include accumulated balance)
        const accumulated = await this._getAccumulated(minerAddress, symbol);
        const total = amount + accumulated;

        if (total >= threshold) {
          eligiblePayments[coinAddress] = total;
          await this._clearAccumulated(minerAddress, symbol);
        } else {
          await this._accumulate(minerAddress, symbol, amount);
        }
      }

      // Execute batch payment
      if (Object.keys(eligiblePayments).length > 0) {
        await this._sendPayments(symbol, rpc, eligiblePayments, block);
      }

      // Mark round paid
      await this.db.query(
        `INSERT INTO rounds (height, total_shares, reward, status, block_id, closed_at, paid_at)
         VALUES ($1, $2, $3, 'paid', $4, NOW(), NOW())
         ON CONFLICT (height) DO UPDATE SET status = 'paid', paid_at = NOW()`,
        [block.height, Object.values(shares).reduce((a, b) => a + b, 0), block.reward, block.id]
      );
    }
  }

  async _getShareDistribution(block) {
    const windowBlocks = this.config.pplnsWindow || 2;
    const startHeight = Math.max(0, block.height - windowBlocks);

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
  }

  _calculatePayments(block, shares, symbol) {
    const totalShares = Object.values(shares).reduce((a, b) => a + b, 0);
    if (totalShares === 0) return {};

    const coinConfig = SCRYPT_COINS[symbol];
    const rewardRaw = block.reward;

    // For aux coins, reward is in the coin's native unit
    const poolFee = this.config.poolFee || 0.02;
    const distributable = rewardRaw * (1 - poolFee);

    const payments = {};
    for (const [address, minerShares] of Object.entries(shares)) {
      const proportion = minerShares / totalShares;
      const amount = distributable * proportion;
      if (amount > 0) {
        payments[address] = amount;
      }
    }

    return payments;
  }

  async _getMinerCoinAddress(ltcAddress, symbol) {
    if (symbol === 'LTC') return ltcAddress;

    try {
      const result = await this.db.query(
        `SELECT coin_address FROM miner_wallets
         WHERE miner_address = $1 AND coin = $2`,
        [ltcAddress, symbol]
      );
      return result.rows.length > 0 ? result.rows[0].coin_address : null;
    } catch {
      return null;
    }
  }

  async _sendPayments(symbol, rpc, payments, block) {
    try {
      const batchSize = 50;
      const addresses = Object.keys(payments);

      for (let i = 0; i < addresses.length; i += batchSize) {
        const batch = {};
        for (const addr of addresses.slice(i, i + batchSize)) {
          batch[addr] = parseFloat(payments[addr].toFixed(8));
        }

        const txid = await rpc.sendMany('', batch);

        log.info({
          coin: symbol,
          txid,
          recipients: Object.keys(batch).length,
          total: Object.values(batch).reduce((a, b) => a + b, 0),
        }, `${symbol} batch payment sent`);

        // Record each payment
        for (const [addr, amount] of Object.entries(batch)) {
          await this.db.query(
            `INSERT INTO payments (address, amount, txid, coin, status, block_height, sent_at)
             VALUES ($1, $2, $3, $4, 'sent', $5, NOW())`,
            [addr, amount, txid, symbol, block.height]
          );
        }

        this.emit('paymentSent', { symbol, txid, batch, block });
      }
    } catch (err) {
      log.error({ coin: symbol, err: err.message }, 'Batch payment failed');
    }
  }

  async _accumulate(minerAddress, symbol, amount) {
    const key = `balance:${symbol}:${minerAddress}`;
    try {
      await this.redis.incrbyfloat(key, amount);
    } catch {}
  }

  async _getAccumulated(minerAddress, symbol) {
    const key = `balance:${symbol}:${minerAddress}`;
    try {
      const val = await this.redis.get(key);
      return parseFloat(val || '0');
    } catch {
      return 0;
    }
  }

  async _clearAccumulated(minerAddress, symbol) {
    const key = `balance:${symbol}:${minerAddress}`;
    try {
      await this.redis.del(key);
    } catch {}
  }
}

module.exports = MultiCoinPaymentProcessor;
