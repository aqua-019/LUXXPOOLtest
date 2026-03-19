/**
 * LUXXPOOL v0.6.0 — Centralized Redis Key Builder
 * Single source of truth for all Redis key construction.
 * Prevents double-prefixing, ensures consistency across
 * shareProcessor, redisDedup, paymentProcessor, statsCollector, API.
 */

class RedisKeys {
  /**
   * @param {string} prefix - Key prefix (default 'lux:')
   */
  constructor(prefix = 'lux:') {
    this.prefix = prefix;
  }

  // ── Share / Round keys ──
  roundShares(height)      { return `${this.prefix}round:${height}:shares`; }
  roundStart(height)       { return `${this.prefix}round:${height}:start`; }
  currentRound()           { return `${this.prefix}round:current`; }

  // ── Worker keys ──
  workerShares(address)    { return `${this.prefix}worker:${address}:shares`; }
  workerLastShare(address) { return `${this.prefix}worker:${address}:lastShare`; }
  workerHashrate(address)  { return `${this.prefix}worker:${address}:hashrate`; }

  // ── Stats keys ──
  totalShares()            { return `${this.prefix}stats:totalShares`; }
  totalBlocks()            { return `${this.prefix}stats:totalBlocks`; }
  poolHashrate()           { return `${this.prefix}stats:poolHashrate`; }
  snapshotHashrate(ts)     { return `${this.prefix}stats:hr:${ts}`; }

  // ── Dedup keys ──
  dedup(jobId, en1, en2, ntime, nonce) {
    return `${this.prefix}dedup:${jobId}:${en1}:${en2}:${ntime}:${nonce}`;
  }

  // ── Payment keys ──
  pendingBalance(address)  { return `${this.prefix}balance:${address}:pending`; }
  lastPayout(address)      { return `${this.prefix}balance:${address}:lastPayout`; }
  paymentLock()            { return `${this.prefix}payment:lock`; }

  // ── Aux chain keys ──
  auxBlocks(coin)          { return `${this.prefix}aux:${coin}:blocks`; }
  auxLastBlock(coin)       { return `${this.prefix}aux:${coin}:lastBlock`; }

  // ── Misc ──
  banList()                { return `${this.prefix}bans`; }
  connectionCount(ip)      { return `${this.prefix}conn:${ip}`; }
}

module.exports = RedisKeys;
