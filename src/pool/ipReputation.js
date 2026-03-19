/**
 * LUXXPOOL v0.7.0 — IP Reputation Manager
 * Tracks per-IP behavior scores over time.
 * Good behavior (valid shares, blocks) increases score.
 * Bad behavior (invalid shares, floods, bans) decreases score.
 * Low-reputation IPs get stricter security thresholds.
 *
 * Score range: 0 (blacklisted) → 100 (fully trusted)
 * Default for new IPs: 50 (neutral)
 */

const { createLogger } = require('../utils/logger');

const log = createLogger('ip-reputation');

// Score adjustments per event type
const SCORE_ADJUSTMENTS = {
  // Positive events
  valid_share:       +0.1,
  block_found:       +5,
  clean_24h:         +2,
  // Negative events
  invalid_share:     -2,
  stale_share:       -0.5,
  connection_flood:  -10,
  protocol_violation: -15,
  ban_triggered:     -25,
  sybil_detected:    -20,
  share_flooding:    -12,
  vardiff_gaming:    -8,
  ntime_manipulation: -15,
};

const MIN_SCORE = 0;
const MAX_SCORE = 100;
const DEFAULT_SCORE = 50;
const HIGH_RISK_THRESHOLD = 30;
const TRUSTED_THRESHOLD = 80;
const REJECT_THRESHOLD = 10;

class IPReputationManager {
  /**
   * @param {object} db - Database query interface
   * @param {object} redis - Redis client
   */
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
    this.cache = new Map();   // ip → { score, totalEvents, banCount, updatedAt }
    this.timer = null;
  }

  start() {
    // Persist scores and run decay every 10 minutes
    this.timer = setInterval(() => this._persistAndDecay(), 600000);
    log.info('IP reputation manager started');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Get reputation score for an IP.
   * @param {string} ip
   * @returns {number} Score 0-100
   */
  getScore(ip) {
    const normalized = this._normalizeIp(ip);
    const entry = this.cache.get(normalized);
    return entry ? entry.score : DEFAULT_SCORE;
  }

  /**
   * Record a behavioral event for an IP.
   * @param {string} ip
   * @param {string} eventType - Key from SCORE_ADJUSTMENTS
   * @param {string} [severity] - 'low', 'medium', 'high'
   */
  recordEvent(ip, eventType, severity) {
    const normalized = this._normalizeIp(ip);
    const adjustment = SCORE_ADJUSTMENTS[eventType];
    if (adjustment === undefined) return;

    let entry = this.cache.get(normalized);
    if (!entry) {
      entry = { score: DEFAULT_SCORE, totalEvents: 0, banCount: 0, updatedAt: Date.now() };
      this.cache.set(normalized, entry);
    }

    // Apply severity multiplier for negative events
    let finalAdjustment = adjustment;
    if (adjustment < 0 && severity === 'high') {
      finalAdjustment *= 1.5;
    }

    entry.score = Math.max(MIN_SCORE, Math.min(MAX_SCORE, entry.score + finalAdjustment));
    entry.totalEvents++;
    entry.updatedAt = Date.now();

    if (eventType === 'ban_triggered') {
      entry.banCount++;
    }

    // Log significant drops
    if (entry.score < HIGH_RISK_THRESHOLD && adjustment < 0) {
      log.warn({ ip: normalized, score: entry.score, event: eventType }, 'IP flagged as high risk');
    }
  }

  /**
   * Check if IP is high risk (score < 30).
   * @param {string} ip
   * @returns {boolean}
   */
  isHighRisk(ip) {
    return this.getScore(ip) < HIGH_RISK_THRESHOLD;
  }

  /**
   * Check if IP is trusted (score > 80).
   * @param {string} ip
   * @returns {boolean}
   */
  isTrusted(ip) {
    return this.getScore(ip) > TRUSTED_THRESHOLD;
  }

  /**
   * Check if IP should be rejected outright (score < 10).
   * @param {string} ip
   * @returns {boolean}
   */
  shouldReject(ip) {
    return this.getScore(ip) < REJECT_THRESHOLD;
  }

  /**
   * Get the number of times an IP has been banned.
   * Used for progressive ban escalation.
   * @param {string} ip
   * @returns {number}
   */
  getBanCount(ip) {
    const normalized = this._normalizeIp(ip);
    const entry = this.cache.get(normalized);
    return entry ? entry.banCount : 0;
  }

  /**
   * Get full reputation data for an IP.
   * @param {string} ip
   * @returns {object}
   */
  getReputation(ip) {
    const normalized = this._normalizeIp(ip);
    const entry = this.cache.get(normalized);
    if (!entry) {
      return {
        ip: normalized,
        score: DEFAULT_SCORE,
        risk: 'neutral',
        totalEvents: 0,
        banCount: 0,
      };
    }

    let risk;
    if (entry.score < REJECT_THRESHOLD) risk = 'blacklisted';
    else if (entry.score < HIGH_RISK_THRESHOLD) risk = 'high';
    else if (entry.score < TRUSTED_THRESHOLD) risk = 'neutral';
    else risk = 'trusted';

    return {
      ip: normalized,
      score: Math.round(entry.score * 10) / 10,
      risk,
      totalEvents: entry.totalEvents,
      banCount: entry.banCount,
      lastEvent: entry.updatedAt ? new Date(entry.updatedAt).toISOString() : null,
    };
  }

  /**
   * Get all high-risk IPs.
   * @returns {Array}
   */
  getHighRiskIPs() {
    const result = [];
    for (const [ip, entry] of this.cache) {
      if (entry.score < HIGH_RISK_THRESHOLD) {
        result.push({ ip, score: Math.round(entry.score * 10) / 10, banCount: entry.banCount });
      }
    }
    return result.sort((a, b) => a.score - b.score);
  }

  /**
   * Load reputation data from database on startup.
   */
  async loadFromDB() {
    try {
      const result = await this.db.query(
        'SELECT ip_address, score, total_events, ban_count, updated_at FROM ip_reputation'
      );
      for (const row of result.rows) {
        this.cache.set(row.ip_address, {
          score: row.score,
          totalEvents: row.total_events,
          banCount: row.ban_count,
          updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
        });
      }
      log.info({ count: result.rows.length }, 'Loaded IP reputation data');
    } catch (err) {
      log.error({ err: err.message }, 'Failed to load IP reputation data');
    }
  }

  // ═══════════════════════════════════════════════════════
  // INTERNAL
  // ═══════════════════════════════════════════════════════

  _normalizeIp(ip) {
    if (!ip) return '0.0.0.0';
    // Strip IPv6-mapped IPv4 prefix
    return ip.replace(/^::ffff:/, '');
  }

  async _persistAndDecay() {
    const now = Date.now();
    const staleThreshold = now - 86400000 * 7; // 7 days

    for (const [ip, entry] of this.cache) {
      // Decay: gradually restore toward neutral (50) for inactive IPs
      if (entry.updatedAt < now - 86400000) { // Inactive > 24h
        const daysSinceEvent = (now - entry.updatedAt) / 86400000;
        const decayAmount = Math.min(daysSinceEvent * 0.5, 5); // Max 5 points per cycle
        if (entry.score < DEFAULT_SCORE) {
          entry.score = Math.min(DEFAULT_SCORE, entry.score + decayAmount);
        }
      }

      // Remove very old, neutral entries
      if (entry.updatedAt < staleThreshold && entry.score >= DEFAULT_SCORE - 5) {
        this.cache.delete(ip);
        continue;
      }

      // Persist to database
      try {
        await this.db.query(
          `INSERT INTO ip_reputation (ip_address, score, total_events, ban_count, last_event, updated_at)
           VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), NOW())
           ON CONFLICT (ip_address)
           DO UPDATE SET score = $2, total_events = $3, ban_count = $4, updated_at = NOW()`,
          [ip, Math.round(entry.score), entry.totalEvents, entry.banCount, entry.updatedAt]
        );
      } catch (err) {
        log.error({ err: err.message, ip }, 'Failed to persist IP reputation');
      }
    }
  }
}

module.exports = IPReputationManager;
