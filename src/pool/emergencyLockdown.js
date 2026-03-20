/**
 * LUXXPOOL v0.7.0 — Emergency Lockdown System
 * ═══════════════════════════════════════════════════════════
 * 4-level graduated response to active threats.
 *
 * Security Context:
 *   - TeamDoge DDoS (2014): 200K+ IPs, 2.5h outage,
 *     "No current DDoS protections can protect the stratum"
 *   - DD4BC extortion campaigns (2015): escalating DDoS
 *     against AntPool, NiceHash, CKPool, GHash.io
 *   - Game-theoretic research: mining pools have economic
 *     incentives to DDoS competitors at sufficient size
 *
 * Levels:
 *   0 (Normal)      — All systems open
 *   1 (Elevated)    — Rate-limited new connections, enhanced logging
 *   2 (Restricted)  — Fleet + reputation >70 only
 *   3 (Maintenance) — Fleet only, all public rejected
 *
 * Auto-escalation enabled by default (user preference).
 * Auto-deescalation after 15 min of stability per level.
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

const LEVEL_NAMES = ['Normal', 'Elevated', 'Restricted', 'Maintenance'];

class EmergencyLockdown extends EventEmitter {
  /**
   * @param {object} deps - { db, auditLog, ipReputation }
   * @param {object} opts
   */
  constructor(deps = {}, opts = {}) {
    super();

    this.db = deps.db;
    this.auditLog = deps.auditLog;
    this.ipReputation = deps.ipReputation;

    // Current state
    this.level = LEVELS.NORMAL;
    this.manualOverride = false;
    this.lastEscalation = 0;
    this.lastDeescalation = 0;

    // Auto-escalation configuration
    this.autoEscalation = opts.autoEscalation !== false; // default ON
    this.deescalationDelayMs = opts.deescalationDelayMs || 900000; // 15 min
    this.reputationThresholdRestricted = opts.reputationThresholdRestricted || 70;

    // Threat metrics (rolling 5-minute windows)
    this.metrics = {
      rejectedConnections: [],  // timestamps of rejected connections
      invalidShares: [],         // timestamps of invalid shares
      bwhDetections: [],         // timestamps of BWH alerts
      securityAlerts: [],        // timestamps of security alerts
    };

    // Auto-escalation thresholds
    this.thresholds = {
      rejectedPerMin: opts.rejectedPerMin || 100,
      invalidPerMin: opts.invalidPerMin || 1000,
      bwhPerHour: opts.bwhPerHour || 3,
      alertsPerMin: opts.alertsPerMin || 50,
    };

    this.checkTimer = null;
    this.checkIntervalMs = opts.checkIntervalMs || 30000; // check every 30s
  }

  start() {
    this.checkTimer = setInterval(() => this._checkThreats(), this.checkIntervalMs);
    log.info({
      autoEscalation: this.autoEscalation,
      deescalationDelay: this.deescalationDelayMs / 60000 + 'min',
    }, 'Emergency lockdown system started — Level 0 (Normal)');
  }

  stop() {
    if (this.checkTimer) clearInterval(this.checkTimer);
  }

  /**
   * Check if a connection should be allowed at the current lockdown level.
   * @param {boolean} isFleet - Whether the miner is fleet (LUXX-owned)
   * @param {string} ip - Client IP address
   * @returns {{ allowed: boolean, reason: string|null }}
   */
  checkConnection(isFleet, ip) {
    // Fleet miners always allowed (trusted hardware on isolated VLAN)
    if (isFleet) return { allowed: true, reason: null };

    switch (this.level) {
      case LEVELS.NORMAL:
        return { allowed: true, reason: null };

      case LEVELS.ELEVATED:
        // Allow but rate-limited (handled by caller)
        return { allowed: true, reason: null };

      case LEVELS.RESTRICTED: {
        // Only fleet + high reputation
        if (this.ipReputation) {
          const { score } = this.ipReputation.checkReputation(ip);
          if (score >= this.reputationThresholdRestricted) {
            return { allowed: true, reason: null };
          }
        }
        return { allowed: false, reason: `Lockdown level ${this.level}: restricted to trusted miners` };
      }

      case LEVELS.MAINTENANCE:
        return { allowed: false, reason: 'Lockdown level 3: maintenance mode — fleet only' };

      default:
        return { allowed: true, reason: null };
    }
  }

  /**
   * Get current lockdown level.
   */
  getLevel() {
    return this.level;
  }

  /**
   * Get human-readable level name.
   */
  getLevelName() {
    return LEVEL_NAMES[this.level] || 'Unknown';
  }

  /**
   * Get connection rate limit multiplier for current level.
   * Level 0: 1x (normal), Level 1: 0.25x, Level 2+: N/A (blocked)
   */
  getRateLimitMultiplier() {
    switch (this.level) {
      case LEVELS.ELEVATED: return 0.25;
      default: return 1;
    }
  }

  /**
   * Manually set lockdown level (admin API).
   */
  async setLevel(level, triggeredBy = 'admin', reason = 'Manual override') {
    if (level < 0 || level > 3) return false;

    const previousLevel = this.level;
    this.level = level;
    this.manualOverride = true;
    this.lastEscalation = Date.now();

    log.warn({
      from: LEVEL_NAMES[previousLevel],
      to: LEVEL_NAMES[level],
      triggeredBy,
      reason,
    }, `LOCKDOWN LEVEL CHANGED: ${LEVEL_NAMES[previousLevel]} → ${LEVEL_NAMES[level]}`);

    this.emit('levelChanged', { level, previousLevel, triggeredBy, reason });

    if (this.auditLog) {
      this.auditLog.lockdown(level, triggeredBy, reason);
    }

    await this._persistLevelChange(level, triggeredBy, reason);
    return true;
  }

  /**
   * Record a rejected connection (for auto-escalation metrics).
   */
  recordRejectedConnection() {
    this.metrics.rejectedConnections.push(Date.now());
  }

  /**
   * Record invalid share burst.
   */
  recordInvalidShare() {
    this.metrics.invalidShares.push(Date.now());
  }

  /**
   * Record BWH detection.
   */
  recordBwhDetection() {
    this.metrics.bwhDetections.push(Date.now());
  }

  /**
   * Record security alert.
   */
  recordSecurityAlert() {
    this.metrics.securityAlerts.push(Date.now());
  }

  /**
   * Get lockdown status for dashboard.
   */
  getStatus() {
    return {
      level: this.level,
      levelName: LEVEL_NAMES[this.level],
      manualOverride: this.manualOverride,
      autoEscalation: this.autoEscalation,
      lastEscalation: this.lastEscalation ? new Date(this.lastEscalation).toISOString() : null,
      lastDeescalation: this.lastDeescalation ? new Date(this.lastDeescalation).toISOString() : null,
      metrics: {
        rejectedPerMin: this._countRecent(this.metrics.rejectedConnections, 60000),
        invalidPerMin: this._countRecent(this.metrics.invalidShares, 60000),
        bwhPerHour: this._countRecent(this.metrics.bwhDetections, 3600000),
        alertsPerMin: this._countRecent(this.metrics.securityAlerts, 60000),
      },
    };
  }

  /**
   * Get lockdown history from database.
   */
  async getHistory(limit = 20) {
    if (!this.db) return [];
    try {
      const result = await this.db.query(
        'SELECT * FROM lockdown_history ORDER BY started_at DESC LIMIT $1',
        [limit]
      );
      return result.rows;
    } catch (err) {
      log.error({ err: err.message }, 'Failed to query lockdown history');
      return [];
    }
  }

  // ─── Internal ──────────────────────────────────────────

  _checkThreats() {
    if (!this.autoEscalation) return;

    // Trim old metrics (keep last 5 min for connection/share, 1 hour for BWH)
    const fiveMinAgo = Date.now() - 300000;
    const oneHourAgo = Date.now() - 3600000;

    this.metrics.rejectedConnections = this.metrics.rejectedConnections.filter(t => t > fiveMinAgo);
    this.metrics.invalidShares = this.metrics.invalidShares.filter(t => t > fiveMinAgo);
    this.metrics.bwhDetections = this.metrics.bwhDetections.filter(t => t > oneHourAgo);
    this.metrics.securityAlerts = this.metrics.securityAlerts.filter(t => t > fiveMinAgo);

    const rejectedPerMin = this._countRecent(this.metrics.rejectedConnections, 60000);
    const invalidPerMin = this._countRecent(this.metrics.invalidShares, 60000);
    const bwhPerHour = this.metrics.bwhDetections.length;
    const alertsPerMin = this._countRecent(this.metrics.securityAlerts, 60000);

    // Check if we should escalate
    let shouldEscalate = false;
    let reason = '';

    if (rejectedPerMin > this.thresholds.rejectedPerMin) {
      shouldEscalate = true;
      reason = `DDoS detected: ${rejectedPerMin} rejected connections/min`;
    } else if (invalidPerMin > this.thresholds.invalidPerMin) {
      shouldEscalate = true;
      reason = `Mass invalid shares: ${invalidPerMin}/min`;
    } else if (bwhPerHour >= this.thresholds.bwhPerHour) {
      shouldEscalate = true;
      reason = `Multiple BWH detections: ${bwhPerHour} in last hour`;
    } else if (alertsPerMin > this.thresholds.alertsPerMin) {
      shouldEscalate = true;
      reason = `Security alert flood: ${alertsPerMin}/min`;
    }

    if (shouldEscalate && this.level < LEVELS.MAINTENANCE) {
      const newLevel = Math.min(this.level + 1, LEVELS.MAINTENANCE);
      this._autoEscalate(newLevel, reason);
      return;
    }

    // Check if we should deescalate
    if (this.level > LEVELS.NORMAL && !this.manualOverride) {
      const timeSinceLastChange = Date.now() - Math.max(this.lastEscalation, this.lastDeescalation);
      if (timeSinceLastChange > this.deescalationDelayMs && !shouldEscalate) {
        this._autoDeescalate();
      }
    }
  }

  async _autoEscalate(newLevel, reason) {
    const previousLevel = this.level;
    this.level = newLevel;
    this.lastEscalation = Date.now();
    this.manualOverride = false;

    log.warn({
      from: LEVEL_NAMES[previousLevel],
      to: LEVEL_NAMES[newLevel],
      reason,
    }, `AUTO-ESCALATION: ${LEVEL_NAMES[previousLevel]} → ${LEVEL_NAMES[newLevel]}`);

    this.emit('levelChanged', { level: newLevel, previousLevel, triggeredBy: 'auto', reason });

    if (this.auditLog) {
      this.auditLog.lockdown(newLevel, 'auto-escalation', reason);
    }

    await this._persistLevelChange(newLevel, 'auto-escalation', reason);
  }

  async _autoDeescalate() {
    const previousLevel = this.level;
    this.level = Math.max(LEVELS.NORMAL, this.level - 1);
    this.lastDeescalation = Date.now();

    log.info({
      from: LEVEL_NAMES[previousLevel],
      to: LEVEL_NAMES[this.level],
    }, `AUTO-DEESCALATION: ${LEVEL_NAMES[previousLevel]} → ${LEVEL_NAMES[this.level]}`);

    this.emit('levelChanged', {
      level: this.level,
      previousLevel,
      triggeredBy: 'auto-deescalation',
      reason: 'Threat metrics below thresholds',
    });

    if (this.auditLog) {
      this.auditLog.lockdown(this.level, 'auto-deescalation', 'Threat cleared');
    }

    // Close out previous lockdown record
    if (this.db) {
      try {
        await this.db.query(
          `UPDATE lockdown_history SET ended_at = NOW()
           WHERE ended_at IS NULL AND level = $1`,
          [previousLevel]
        );
      } catch (err) {
        log.debug({ err: err.message }, 'Failed to update lockdown history');
      }
    }
  }

  async _persistLevelChange(level, triggeredBy, reason) {
    if (!this.db) return;
    try {
      await this.db.query(
        `INSERT INTO lockdown_history (level, triggered_by, started_at, reason)
         VALUES ($1, $2, NOW(), $3)`,
        [level, triggeredBy, reason]
      );
    } catch (err) {
      log.error({ err: err.message }, 'Failed to persist lockdown change');
    }
  }

  _countRecent(timestamps, windowMs) {
    const cutoff = Date.now() - windowMs;
    return timestamps.filter(t => t > cutoff).length;
  }
}

EmergencyLockdown.LEVELS = LEVELS;
EmergencyLockdown.LEVEL_NAMES = LEVEL_NAMES;

module.exports = EmergencyLockdown;
