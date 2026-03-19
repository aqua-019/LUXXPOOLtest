/**
 * LUXXPOOL v0.4.0 — Profit Estimator
 * Calculates estimated earnings per miner based on their
 * hashrate, network difficulty, block rewards, and pool fee.
 */

const { SCRYPT_COINS } = require('../../config/coins');

const DIFF1_HASHES = 4294967296; // 2^32

class ProfitEstimator {
  /**
   * Estimate daily earnings for a given hashrate
   * @param {number} minerHashrate - H/s
   * @param {number} networkDifficulty - Current network difficulty
   * @param {number} poolFee - Pool fee as decimal (0.02 = 2%)
   * @returns {object} Estimated earnings per coin
   */
  static estimateDaily(minerHashrate, networkDifficulty, poolFee = 0.02) {
    if (!minerHashrate || !networkDifficulty) return null;

    // LTC: blocks per day = 576 (2.5 min per block, 1440 min/day)
    const ltcBlocksPerDay = 576;
    const ltcBlockReward = 6.25;

    // Network hashrate = difficulty * 2^32 / blockTime
    const networkHashrate = (networkDifficulty * DIFF1_HASHES) / 150; // 150s block time

    // Miner's share of network
    const minerShare = minerHashrate / networkHashrate;

    // Expected blocks per day from this miner
    const expectedBlocks = ltcBlocksPerDay * minerShare;

    // LTC earnings after pool fee
    const ltcDaily = expectedBlocks * ltcBlockReward * (1 - poolFee);

    // DOGE: 1440 blocks/day (1 min), 10000 DOGE reward
    const dogeBlocksPerDay = 1440;
    const dogeBlockReward = 10000;
    // Merged mining: same hashrate mines DOGE simultaneously
    // DOGE difficulty is typically much lower, so miner gets proportional share
    const dogeDaily = dogeBlocksPerDay * minerShare * dogeBlockReward * (1 - poolFee);

    return {
      ltc: {
        daily: parseFloat(ltcDaily.toFixed(6)),
        weekly: parseFloat((ltcDaily * 7).toFixed(6)),
        monthly: parseFloat((ltcDaily * 30).toFixed(6)),
      },
      doge: {
        daily: parseFloat(dogeDaily.toFixed(2)),
        weekly: parseFloat((dogeDaily * 7).toFixed(2)),
        monthly: parseFloat((dogeDaily * 30).toFixed(2)),
      },
      minerSharePct: (minerShare * 100).toFixed(6) + '%',
      expectedBlocksPerDay: expectedBlocks.toFixed(4),
      networkHashrate,
    };
  }

  /**
   * Estimate time to find a solo block
   * @param {number} minerHashrate - H/s
   * @param {number} networkDifficulty
   * @returns {object}
   */
  static estimateSoloBlockTime(minerHashrate, networkDifficulty) {
    if (!minerHashrate || !networkDifficulty) return null;

    const networkHashrate = (networkDifficulty * DIFF1_HASHES) / 150;
    const minerShare = minerHashrate / networkHashrate;

    // Expected time between blocks = blockTime / minerShare
    const expectedSeconds = 150 / minerShare;
    const expectedDays = expectedSeconds / 86400;

    return {
      expectedSeconds: Math.round(expectedSeconds),
      expectedDays: parseFloat(expectedDays.toFixed(1)),
      expectedWeeks: parseFloat((expectedDays / 7).toFixed(1)),
      probability24h: parseFloat((1 - Math.exp(-86400 / expectedSeconds)).toFixed(6)),
    };
  }
}

module.exports = ProfitEstimator;
