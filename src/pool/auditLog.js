/**
 * LUXXPOOL v0.7.0 — Forensic Audit Log
 * ═══════════════════════════════════════════════════════════
 * Structured logging for all security events, admin actions,
 * ban events, lockdown changes, and payment events.
 *
 * Security Context:
 *   - NiceHash breach (2017): lack of forensic logs delayed
 *     attribution to Lazarus Group until 2021 indictment
 *   - SBI Crypto hack (2025): forensic logging critical for
 *     multi-chain incident response
 *   - All security-relevant actions must be traceable
 */

const { createLogger } = require('../utils/logger');

const log = createLogger('audit');

class AuditLog {
  /**
   * @param {object} deps
   * @param {object} deps.db - Database query interface
   * @param {object} opts
   * @param {number} opts.retentionDays - Days to retain logs (default 90)
   * @param {number} opts.cleanupIntervalMs - Cleanup interval (default 1h)
   */
  constructor(deps = {}, opts = {}) {
    this.db = deps.db;
    this.retentionDays = opts.retentionDays || 90;
    this.cleanupIntervalMs = opts.cleanupIntervalMs || 3600000;
    this.cleanupTimer = null;

    // In-memory buffer for high-frequency events (flush periodically)
    this.buffer = [];
    this.bufferLimit = 50;
    this.flushTimer = null;
  }

  start() {
    this.flushTimer = setInterval(() => this._flush(), 10000); // flush every 10s
    this.cleanupTimer = setInterval(() => this._cleanup(), this.cleanupIntervalMs);
    log.info({ retentionDays: this.retentionDays }, 'Audit log started');
  }

  stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this._flush(); // final flush
  }

  /**
   * Log a security event
   */
  security(type, details = {}) {
    this._record({
      event_type: `security:${type}`,
      actor: details.ip || details.address || 'system',
      target: details.target || details.address || null,
      details,
      severity: details.severity || 'WARN',
    });
  }

  /**
   * Log an admin action
   */
  admin(action, actor, details = {}) {
    this._record({
      event_type: `admin:${action}`,
      actor: actor || 'admin',
      target: details.target || null,
      details,
      severity: 'INFO',
    });
  }

  /**
   * Log a ban event
   */
  ban(ip, reason, details = {}) {
    this._record({
      event_type: 'security:ban',
      actor: 'system',
      target: ip,
      details: { reason, ...details },
      severity: details.permanent ? 'HIGH' : 'WARN',
    });
  }

  /**
   * Log a lockdown level change
   */
  lockdown(level, triggeredBy, reason) {
    this._record({
      event_type: 'security:lockdown',
      actor: triggeredBy,
      target: `level:${level}`,
      details: { level, reason },
      severity: level >= 2 ? 'HIGH' : 'WARN',
    });
  }

  /**
   * Log a payment event
   */
  payment(type, details = {}) {
    this._record({
      event_type: `payment:${type}`,
      actor: 'system',
      target: details.address || null,
      details,
      severity: 'INFO',
    });
  }

  /**
   * Log a firmware advisory
   */
  firmware(type, details = {}) {
    this._record({
      event_type: `firmware:${type}`,
      actor: details.ip || 'system',
      target: details.model || null,
      details,
      severity: details.critical ? 'HIGH' : 'INFO',
    });
  }

  /**
   * Query audit log with filters
   */
  async query(filters = {}) {
    if (!this.db) return [];

    const conditions = ['1=1'];
    const params = [];
    let paramIdx = 1;

    if (filters.eventType) {
      conditions.push(`event_type LIKE $${paramIdx++}`);
      params.push(`${filters.eventType}%`);
    }
    if (filters.severity) {
      conditions.push(`severity = $${paramIdx++}`);
      params.push(filters.severity);
    }
    if (filters.actor) {
      conditions.push(`actor = $${paramIdx++}`);
      params.push(filters.actor);
    }
    if (filters.since) {
      conditions.push(`timestamp > $${paramIdx++}`);
      params.push(new Date(filters.since));
    }

    const limit = Math.min(filters.limit || 100, 500);
    const offset = filters.offset || 0;

    try {
      const result = await this.db.query(
        `SELECT * FROM audit_log
         WHERE ${conditions.join(' AND ')}
         ORDER BY timestamp DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        [...params, limit, offset]
      );
      return result.rows;
    } catch (err) {
      log.error({ err: err.message }, 'Audit log query failed');
      return [];
    }
  }

  // ─── Internal ──────────────────────────────────────────

  _record(entry) {
    entry.timestamp = new Date();
    this.buffer.push(entry);

    // Log to application log as well
    log.info({ type: entry.event_type, actor: entry.actor, target: entry.target, severity: entry.severity }, 'Audit event');

    if (this.buffer.length >= this.bufferLimit) {
      this._flush();
    }
  }

  async _flush() {
    if (!this.db || this.buffer.length === 0) return;

    const entries = this.buffer.splice(0);

    for (const entry of entries) {
      try {
        await this.db.query(
          `INSERT INTO audit_log (timestamp, event_type, actor, target, details, severity)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [entry.timestamp, entry.event_type, entry.actor, entry.target,
           JSON.stringify(entry.details), entry.severity]
        );
      } catch (err) {
        log.error({ err: err.message, event: entry.event_type }, 'Audit log write failed');
      }
    }
  }

  async _cleanup() {
    if (!this.db) return;

    try {
      const result = await this.db.query(
        `DELETE FROM audit_log WHERE timestamp < NOW() - INTERVAL '1 day' * $1`,
        [this.retentionDays]
      );
      if (result.rowCount > 0) {
        log.info({ removed: result.rowCount, retentionDays: this.retentionDays }, 'Audit log cleanup');
      }
    } catch (err) {
      log.error({ err: err.message }, 'Audit log cleanup failed');
    }
  }
}

module.exports = AuditLog;
