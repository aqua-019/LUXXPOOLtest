/**
 * LUXXPOOL v0.7.0 — Audit Logger
 * Forensic-grade audit logging for security events,
 * admin actions, bans, and lockdown changes.
 * Persists to PostgreSQL audit_log table.
 */

const { createLogger } = require('../utils/logger');

const log = createLogger('audit');

class AuditLogger {
  /**
   * @param {object} db - Database query interface
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Log an admin action (API key rotation, lockdown change, manual ban, etc.)
   * @param {string} action - e.g. 'lockdown_set', 'ban_manual', 'key_rotated'
   * @param {object} details - Structured details
   * @param {string} adminIp - Admin's IP address
   */
  async logAdminAction(action, details, adminIp) {
    await this._write('admin_action', 'info', adminIp, action, details);
  }

  /**
   * Log a security event (attack detected, threshold exceeded, etc.)
   * @param {string} event - e.g. 'share_flooding', 'sybil_detected', 'bwh_suspected'
   * @param {string} severity - 'low', 'medium', 'high', 'critical'
   * @param {object} context - { ip, address, details }
   */
  async logSecurityEvent(event, severity, context) {
    await this._write(event, severity, context.ip, context.address, context.details || {});
  }

  /**
   * Log a ban action (automatic or manual).
   * @param {string} ip
   * @param {string} reason
   * @param {number} duration - Ban duration in seconds
   * @param {string} triggeredBy - 'auto' or 'admin'
   */
  async logBanAction(ip, reason, duration, triggeredBy) {
    await this._write('ban', 'medium', ip, null, { reason, duration, triggeredBy });
  }

  /**
   * Log a lockdown level change.
   * @param {number} fromLevel
   * @param {number} toLevel
   * @param {string} reason
   * @param {string} triggeredBy - 'auto' or 'admin:<ip>'
   */
  async logLockdownChange(fromLevel, toLevel, reason, triggeredBy) {
    const severity = toLevel >= 2 ? 'high' : (toLevel >= 1 ? 'medium' : 'info');
    await this._write('lockdown_change', severity, null, null, {
      fromLevel, toLevel, reason, triggeredBy,
    });
  }

  /**
   * Log a miner connection event (for forensics).
   * @param {string} ip
   * @param {string} address
   * @param {object} details - { userAgent, model, action }
   */
  async logConnectionEvent(ip, address, details) {
    await this._write('connection', 'low', ip, address, details);
  }

  /**
   * Query audit log with filters.
   * @param {{ type, severity, since, limit, offset }} filters
   * @returns {Array}
   */
  async query(filters = {}) {
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (filters.type) {
      conditions.push(`event_type = $${paramIdx++}`);
      params.push(filters.type);
    }
    if (filters.severity) {
      conditions.push(`severity = $${paramIdx++}`);
      params.push(filters.severity);
    }
    if (filters.since) {
      conditions.push(`created_at > $${paramIdx++}`);
      params.push(filters.since);
    }
    if (filters.ip) {
      conditions.push(`source_ip = $${paramIdx++}`);
      params.push(filters.ip);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit || 100, 500);
    const offset = filters.offset || 0;

    try {
      const result = await this.db.query(
        `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, limit, offset]
      );
      return result.rows;
    } catch (err) {
      log.error({ err: err.message }, 'Audit log query failed');
      return [];
    }
  }

  /**
   * Get audit log summary (counts by type/severity in last 24h).
   * @returns {object}
   */
  async getSummary() {
    try {
      const result = await this.db.query(
        `SELECT event_type, severity, COUNT(*) as count
         FROM audit_log
         WHERE created_at > NOW() - INTERVAL '24 hours'
         GROUP BY event_type, severity
         ORDER BY count DESC`
      );
      return result.rows;
    } catch (err) {
      log.error({ err: err.message }, 'Audit summary query failed');
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════
  // INTERNAL
  // ═══════════════════════════════════════════════════════

  async _write(eventType, severity, sourceIp, target, details) {
    try {
      await this.db.query(
        `INSERT INTO audit_log (event_type, severity, source_ip, target, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [eventType, severity, sourceIp || null, target || null, JSON.stringify(details || {})]
      );
    } catch (err) {
      // Fallback to structured log if DB write fails
      log.error({
        err: err.message,
        eventType,
        severity,
        sourceIp,
        target,
        details,
      }, 'Failed to write audit log to database');
    }
  }
}

module.exports = AuditLogger;
