/**
 * LUXXPOOL v0.7.0 — Emergency Lockdown System
 * Graduated response to active attacks on the pool.
 *
 * Levels:
 *   0 = NORMAL      — Standard operation
 *   1 = ELEVATED    — Stricter rate limits, tighter security thresholds
 *   2 = RESTRICTED  — Only fleet + trusted IPs, reject new unknowns
 *   3 = MAINTENANCE — Graceful disconnect all non-fleet, reject everything
 *
 * Supports both automatic escalation (from threat metrics)
 * and manual admin control via API.
 */

const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');

const log = createLogger('lockdown');

const LEVELS = {
  NORMAL: 0,
  ELEVATED: 1,
  RESTRICTED: 2,
  MAINTENANCE: 3,
};

const LEVEL_NAMES = ['normal', 'elevated', 'restricted', 'maintenance'];

// Auto-escalation thresholds
const ESCALATION_THRESHOLDS = {
  // Escalate to ELEVATED when:
  1: {
    securityEventsPerMinute: 10,
    bannedIPsPerHour: 20,
    invalidShareRate: 0.3,     // 30%+ invalid shares pool-wide
  },
  // Escalate to RESTRICTED when:
  2: {
    securityEventsPerMinute: 30,
    bannedIPsPerHour: 50,
    invalidShareRate: 0.5,
  },
  // Escalate to MAINTENANCE when:
  3: {
    securityEventsPerMinute: 100,
    bannedIPsPerHour: 100,
    invalidShareRate: 0.7,
  },
};

// Cooldown before auto-deescalation (per level)
const COOLDOWN_MS = {
  1: 300000,    // 5 minutes at ELEVATED before going back to NORMAL
  2: 600000,    // 10 minutes at RESTRICTED
  3: 1800000,   // 30 minutes at MAINTENANCE
};

class EmergencyLockdown extends EventEmitter {
  constructor() {
    super();
    this.level = LEVELS.NORMAL;
    this.reason = null;
    this.changedAt = null;
    this.changedBy = null;        // 'auto' or 'admin:<ip>'
    this.expiresAt = null;        // For timed lockdowns
    this.cooldownTimer = null;
    this.history = [];            // Recent lockdown changes

    // Threat metrics (rolling window)
    this.metrics = {
      securityEvents: [],         // timestamps of recent security events
      bans: [],                   // timestamps of recent bans
      invalidShares: 0,
      totalShares: 0,
    };
  }

  start() {
    // Check for auto-deescalation every 60 seconds
    this.cooldownTimer = setInterval(() => this._checkCooldown(), 60000);
    log.info('Emergency lockdown system started (level 0: normal)');
  }

  stop() {
    if (this.cooldownTimer) clearInterval(this.cooldownTimer);
  }

  /**
   * Get current lockdown level and status.
   * @returns {{ level, name, reason, changedAt, changedBy, expiresAt }}
   */
  getStatus() {
    return {
      level: this.level,
      name: LEVEL_NAMES[this.level],
      reason: this.reason,
      changedAt: this.changedAt ? new Date(this.changedAt).toISOString() : null,
      changedBy: this.changedBy,
      expiresAt: this.expiresAt ? new Date(this.expiresAt).toISOString() : null,
      recentHistory: this.history.slice(-10),
    };
  }

  /**
   * Manually set lockdown level (admin action).
   * @param {number} level - 0-3
   * @param {string} reason
   * @param {string} adminIp
   * @param {number} [durationMs] - Optional auto-expire duration
   * @returns {boolean} Success
   */
  setLevel(level, reason, adminIp, durationMs) {
    if (level < 0 || level > 3) return false;

    const previous = this.level;
    this.level = level;
    this.reason = reason;
    this.changedAt = Date.now();
    this.changedBy = `admin:${adminIp || 'unknown'}`;
    this.expiresAt = durationMs ? Date.now() + durationMs : null;

    this._recordChange(previous, level, reason, this.changedBy);

    log.warn({
      previous: LEVEL_NAMES[previous],
      current: LEVEL_NAMES[level],
      reason,
      admin: adminIp,
    }, 'Lockdown level changed by admin');

    this.emit('levelChanged', { previous, current: level, reason, changedBy: this.changedBy });
    return true;
  }

  /**
   * Check if a new connection should be accepted at the current lockdown level.
   * @param {string} ip
   * @param {boolean} isFleet - Is this a fleet-whitelisted miner?
   * @param {boolean} isTrusted - Is this IP trusted (reputation > 80)?
   * @returns {{ allowed: boolean, reason: string|null }}
   */
  shouldAcceptConnection(ip, isFleet, isTrusted) {
    switch (this.level) {
      case LEVELS.NORMAL:
      case LEVELS.ELEVATED:
        return { allowed: true, reason: null };

      case LEVELS.RESTRICTED:
        if (isFleet || isTrusted) return { allowed: true, reason: null };
        return { allowed: false, reason: `Pool in restricted mode (level 2): only trusted miners accepted. Reason: ${this.reason}` };

      case LEVELS.MAINTENANCE:
        if (isFleet) return { allowed: true, reason: null };
        return { allowed: false, reason: `Pool in maintenance mode (level 3): only fleet miners accepted. Reason: ${this.reason}` };

      default:
        return { allowed: true, reason: null };
    }
  }

  /**
   * Get the security threshold multiplier for the current lockdown level.
   * Higher lockdown = stricter thresholds (lower multiplier).
   * @returns {number} Multiplier (1.0 = normal, 0.5 = twice as strict)
   */
  getThresholdMultiplier() {
    switch (this.level) {
      case LEVELS.NORMAL:    return 1.0;
      case LEVELS.ELEVATED:  return 0.7;   // 30% stricter
      case LEVELS.RESTRICTED: return 0.5;  // 50% stricter
      case LEVELS.MAINTENANCE: return 0.3; // 70% stricter
      default: return 1.0;
    }
  }

  /**
   * Feed threat metrics for automatic escalation.
   * Called by security systems when events occur.
   * @param {string} eventType - 'security_event', 'ban', 'invalid_share', 'valid_share'
   */
  recordThreatMetric(eventType) {
    const now = Date.now();

    switch (eventType) {
      case 'security_event':
        this.metrics.securityEvents.push(now);
        break;
      case 'ban':
        this.metrics.bans.push(now);
        break;
      case 'invalid_share':
        this.metrics.invalidShares++;
        this.metrics.totalShares++;
        break;
      case 'valid_share':
        this.metrics.totalShares++;
        break;
    }

    // Prune old metrics (keep last hour)
    const hourAgo = now - 3600000;
    this.metrics.securityEvents = this.metrics.securityEvents.filter(t => t > hourAgo);
    this.metrics.bans = this.metrics.bans.filter(t => t > hourAgo);

    // Check for auto-escalation
    this._checkAutoEscalation();
  }

  // ═══════════════════════════════════════════════════════
  // INTERNAL
  // ═══════════════════════════════════════════════════════

  _checkAutoEscalation() {
    // Don't auto-escalate if manually set
    if (this.changedBy && this.changedBy.startsWith('admin:')) return;

    const now = Date.now();
    const minuteAgo = now - 60000;
    const hourAgo = now - 3600000;

    const currentMetrics = {
      securityEventsPerMinute: this.metrics.securityEvents.filter(t => t > minuteAgo).length,
      bannedIPsPerHour: this.metrics.bans.filter(t => t > hourAgo).length,
      invalidShareRate: this.metrics.totalShares > 100
        ? this.metrics.invalidShares / this.metrics.totalShares
        : 0,
    };

    // Check each level from highest to lowest
    for (let targetLevel = 3; targetLevel >= 1; targetLevel--) {
      if (this.level >= targetLevel) continue;

      const thresholds = ESCALATION_THRESHOLDS[targetLevel];
      const triggered =
        currentMetrics.securityEventsPerMinute >= thresholds.securityEventsPerMinute ||
        currentMetrics.bannedIPsPerHour >= thresholds.bannedIPsPerHour ||
        currentMetrics.invalidShareRate >= thresholds.invalidShareRate;

      if (triggered) {
        const previous = this.level;
        this.level = targetLevel;
        this.reason = `Auto-escalated: events/min=${currentMetrics.securityEventsPerMinute}, bans/hr=${currentMetrics.bannedIPsPerHour}, invalid=${Math.round(currentMetrics.invalidShareRate * 100)}%`;
        this.changedAt = now;
        this.changedBy = 'auto';
        this.expiresAt = null;

        this._recordChange(previous, targetLevel, this.reason, 'auto');

        log.warn({
          previous: LEVEL_NAMES[previous],
          current: LEVEL_NAMES[targetLevel],
          metrics: currentMetrics,
        }, 'Auto-escalated lockdown level');

        this.emit('levelChanged', { previous, current: targetLevel, reason: this.reason, changedBy: 'auto' });
        break;
      }
    }
  }

  _checkCooldown() {
    // Timed expiration
    if (this.expiresAt && Date.now() >= this.expiresAt) {
      this.setLevel(LEVELS.NORMAL, 'Timed lockdown expired', null);
      return;
    }

    // Auto-deescalation (only for auto-escalated levels)
    if (this.level > 0 && this.changedBy === 'auto' && this.changedAt) {
      const elapsed = Date.now() - this.changedAt;
      const cooldown = COOLDOWN_MS[this.level] || 600000;

      if (elapsed >= cooldown) {
        // Check if threat has subsided
        const minuteAgo = Date.now() - 60000;
        const recentEvents = this.metrics.securityEvents.filter(t => t > minuteAgo).length;

        // Only deescalate if events have calmed down
        const targetThreshold = ESCALATION_THRESHOLDS[this.level];
        if (recentEvents < targetThreshold.securityEventsPerMinute * 0.3) {
          const previous = this.level;
          const newLevel = Math.max(0, this.level - 1);
          this.level = newLevel;
          this.reason = 'Auto-deescalated: threat metrics normalized';
          this.changedAt = Date.now();
          this.changedBy = 'auto';

          this._recordChange(previous, newLevel, this.reason, 'auto');

          log.info({
            previous: LEVEL_NAMES[previous],
            current: LEVEL_NAMES[newLevel],
          }, 'Auto-deescalated lockdown level');

          this.emit('levelChanged', { previous, current: newLevel, reason: this.reason, changedBy: 'auto' });
        }
      }
    }

    // Reset share counters periodically
    if (this.metrics.totalShares > 10000) {
      this.metrics.invalidShares = Math.round(this.metrics.invalidShares * 0.1);
      this.metrics.totalShares = Math.round(this.metrics.totalShares * 0.1);
    }
  }

  _recordChange(previous, current, reason, changedBy) {
    this.history.push({
      from: LEVEL_NAMES[previous],
      to: LEVEL_NAMES[current],
      reason,
      changedBy,
      timestamp: new Date().toISOString(),
    });

    // Keep last 50 entries
    if (this.history.length > 50) {
      this.history = this.history.slice(-50);
    }
  }
}

EmergencyLockdown.LEVELS = LEVELS;
EmergencyLockdown.LEVEL_NAMES = LEVEL_NAMES;

module.exports = EmergencyLockdown;
