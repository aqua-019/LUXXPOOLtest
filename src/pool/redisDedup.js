/**
 * LUXXPOOL v0.6.0 — Redis Share Deduplication
 * Uses centralized RedisKeys for key construction.
 */

const { createLogger } = require('../utils/logger');
const log = createLogger('dedup');

class RedisShareDedup {
  /**
   * @param {object} redis - ioredis client
   * @param {object} redisKeys - RedisKeys instance
   * @param {number} ttl - TTL in seconds (default 600)
   */
  constructor(redis, redisKeys, ttl = 600) {
    this.redis = redis;
    this.keys = redisKeys;
    this.ttl = ttl;
    this.fallbackSet = new Set();
    this.maxFallback = 50000;
  }

  /**
   * Check if a share is a duplicate. Returns true if DUPLICATE.
   */
  async isDuplicate(extraNonce1, extraNonce2, ntime, nonce, jobId) {
    const key = this.keys.dedup(jobId, extraNonce1, extraNonce2, ntime, nonce);
    try {
      const result = await this.redis.set(key, '1', 'EX', this.ttl, 'NX');
      return result === null;
    } catch (err) {
      if (!this._fallbackWarned) {
        log.warn({ err: err.message }, 'Redis unavailable — using in-memory dedup fallback (not cluster-safe)');
        this._fallbackWarned = true;
      }
      return this._fallbackCheck(key);
    }
  }

  _fallbackCheck(key) {
    if (this.fallbackSet.has(key)) return true;
    this.fallbackSet.add(key);
    if (this.fallbackSet.size > this.maxFallback) {
      const iter = this.fallbackSet.values();
      for (let i = 0; i < 10000; i++) this.fallbackSet.delete(iter.next().value);
    }
    return false;
  }
}

module.exports = RedisShareDedup;
