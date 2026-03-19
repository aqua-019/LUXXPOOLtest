/**
 * LUXXPOOL — DDoS & Abuse Banning System
 * Tracks invalid share rates, connection flooding, and
 * automatically bans abusive IPs at the stratum level.
 */

const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');

const log = createLogger('banning');

class BanningManager extends EventEmitter {
  /**
   * @param {object} config
   * @param {number} config.invalidPercent - Max invalid share % before ban (default 50)
   * @param {number} config.checkWindow - Window in ms to evaluate (default 300000 = 5 min)
   * @param {number} config.banDuration - Ban duration in seconds (default 3600)
   * @param {number} config.maxConnectionsPerIp - Max simultaneous connections (default 5)
   * @param {number} config.maxConnectionRate - Max new connections per minute per IP (default 10)
   * @param {object} deps
   * @param {object} deps.db - Database query interface
   */
  constructor(config = {}, deps = {}) {
    super();

    this.invalidPercent = config.invalidPercent || 50;
    this.checkWindow = config.checkWindow || 300000;
    this.banDuration = config.banDuration || 3600;
    this.maxConnectionsPerIp = config.maxConnectionsPerIp || 5;
    this.maxConnectionRate = config.maxConnectionRate || 10;

    this.db = deps.db;

    // In-memory tracking
    this.bannedIps = new Map();     // ip → { reason, expiresAt }
    this.shareTracking = new Map(); // ip → { valid: n, invalid: n, lastReset: timestamp }
    this.connectionRate = new Map(); // ip → [timestamps]
    this.warnings = new Map();      // ip → warning count

    // Cleanup timer
    this.cleanupTimer = null;
  }

  start() {
    // Load existing bans from database
    this._loadBans();

    // Periodic cleanup of expired bans
    this.cleanupTimer = setInterval(() => this._cleanup(), 60000);

    log.info({
      invalidPercent: this.invalidPercent,
      banDuration: this.banDuration,
      maxConnsPerIp: this.maxConnectionsPerIp,
    }, 'Banning manager started');
  }

  stop() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  // ═══════════════════════════════════════════════════════
  // BAN CHECKING
  // ═══════════════════════════════════════════════════════

  /**
   * Check if an IP is currently banned
   * @param {string} ip
   * @returns {boolean}
   */
  isBanned(ip) {
    const normalizedIp = this._normalizeIp(ip);
    const ban = this.bannedIps.get(normalizedIp);

    if (!ban) return false;

    // Check if ban has expired
    if (!ban.permanent && Date.now() > ban.expiresAt) {
      this.bannedIps.delete(normalizedIp);
      log.info({ ip: normalizedIp }, 'Ban expired');
      return false;
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════
  // EVENT RECORDING
  // ═══════════════════════════════════════════════════════

  /**
   * Record a valid share from an IP
   */
  recordValidShare(ip) {
    const normalizedIp = this._normalizeIp(ip);
    const tracking = this._getShareTracking(normalizedIp);
    tracking.valid++;
  }

  /**
   * Record an invalid share from an IP
   */
  recordInvalidShare(ip) {
    const normalizedIp = this._normalizeIp(ip);
    const tracking = this._getShareTracking(normalizedIp);
    tracking.invalid++;

    // Check if ban threshold exceeded
    const total = tracking.valid + tracking.invalid;
    if (total >= 10) { // Minimum sample size
      const invalidRate = (tracking.invalid / total) * 100;

      if (invalidRate >= this.invalidPercent) {
        this.ban(normalizedIp, `Invalid share rate: ${invalidRate.toFixed(1)}% (${tracking.invalid}/${total})`);
      }
    }
  }

  /**
   * Record a new connection from an IP.
   * Returns false if the connection should be rejected.
   */
  recordConnection(ip) {
    const normalizedIp = this._normalizeIp(ip);

    if (this.isBanned(normalizedIp)) return false;

    // Track connection rate
    const now = Date.now();
    if (!this.connectionRate.has(normalizedIp)) {
      this.connectionRate.set(normalizedIp, []);
    }

    const timestamps = this.connectionRate.get(normalizedIp);
    timestamps.push(now);

    // Keep only last minute
    const oneMinuteAgo = now - 60000;
    const recent = timestamps.filter(t => t > oneMinuteAgo);
    this.connectionRate.set(normalizedIp, recent);

    // Check connection rate
    if (recent.length > this.maxConnectionRate) {
      this.ban(normalizedIp, `Connection flood: ${recent.length} connections in 60s`);
      return false;
    }

    return true;
  }

  /**
   * Record a protocol violation (malformed data, buffer overflow, etc.)
   */
  recordViolation(ip, reason) {
    const normalizedIp = this._normalizeIp(ip);
    const count = (this.warnings.get(normalizedIp) || 0) + 1;
    this.warnings.set(normalizedIp, count);

    log.warn({ ip: normalizedIp, reason, warnings: count }, 'Protocol violation');

    // Ban after 3 violations
    if (count >= 3) {
      this.ban(normalizedIp, `Protocol violations: ${reason} (${count}x)`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // BANNING
  // ═══════════════════════════════════════════════════════

  /**
   * Ban an IP address
   * @param {string} ip
   * @param {string} reason
   * @param {boolean} permanent
   */
  async ban(ip, reason, permanent = false) {
    const normalizedIp = this._normalizeIp(ip);

    if (this.bannedIps.has(normalizedIp)) return; // Already banned

    const expiresAt = permanent ? Infinity : Date.now() + (this.banDuration * 1000);

    this.bannedIps.set(normalizedIp, {
      reason,
      bannedAt: Date.now(),
      expiresAt,
      permanent,
    });

    log.info({
      ip: normalizedIp,
      reason,
      duration: permanent ? 'permanent' : `${this.banDuration}s`,
    }, '🚫 IP BANNED');

    // Persist to database
    if (this.db) {
      try {
        await this.db.query(
          `INSERT INTO banned_ips (ip_address, reason, banned_at, expires_at, permanent)
           VALUES ($1, $2, NOW(), $3, $4)
           ON CONFLICT (ip_address) DO UPDATE SET
             reason = $2, banned_at = NOW(), expires_at = $3, permanent = $4`,
          [
            normalizedIp,
            reason,
            permanent ? null : new Date(expiresAt),
            permanent,
          ]
        );
      } catch (err) {
        log.error({ err: err.message }, 'Failed to persist ban');
      }
    }

    // Clean up tracking data
    this.shareTracking.delete(normalizedIp);
    this.connectionRate.delete(normalizedIp);
    this.warnings.delete(normalizedIp);

    this.emit('banned', normalizedIp, reason, permanent);
  }

  /**
   * Unban an IP address
   */
  async unban(ip) {
    const normalizedIp = this._normalizeIp(ip);
    this.bannedIps.delete(normalizedIp);

    if (this.db) {
      try {
        await this.db.query(
          'DELETE FROM banned_ips WHERE ip_address = $1',
          [normalizedIp]
        );
      } catch (err) {
        log.error({ err: err.message }, 'Failed to remove ban from DB');
      }
    }

    log.info({ ip: normalizedIp }, 'IP unbanned');
    this.emit('unbanned', normalizedIp);
  }

  // ═══════════════════════════════════════════════════════
  // STATS
  // ═══════════════════════════════════════════════════════

  /**
   * Get all currently banned IPs
   */
  getBannedList() {
    const list = [];
    for (const [ip, ban] of this.bannedIps) {
      if (!ban.permanent && Date.now() > ban.expiresAt) continue;
      list.push({
        ip,
        reason: ban.reason,
        bannedAt: new Date(ban.bannedAt).toISOString(),
        expiresAt: ban.permanent ? 'never' : new Date(ban.expiresAt).toISOString(),
        permanent: ban.permanent,
      });
    }
    return list;
  }

  getBannedCount() {
    return this.bannedIps.size;
  }

  // ═══════════════════════════════════════════════════════
  // INTERNAL
  // ═══════════════════════════════════════════════════════

  _getShareTracking(ip) {
    if (!this.shareTracking.has(ip)) {
      this.shareTracking.set(ip, { valid: 0, invalid: 0, lastReset: Date.now() });
    }

    const tracking = this.shareTracking.get(ip);

    // Reset window if expired
    if (Date.now() - tracking.lastReset > this.checkWindow) {
      tracking.valid = 0;
      tracking.invalid = 0;
      tracking.lastReset = Date.now();
    }

    return tracking;
  }

  _normalizeIp(ip) {
    if (!ip) return 'unknown';
    // Strip IPv6 prefix from IPv4-mapped addresses
    return ip.replace(/^::ffff:/, '');
  }

  async _loadBans() {
    if (!this.db) return;

    try {
      const result = await this.db.query(
        `SELECT * FROM banned_ips
         WHERE permanent = true OR expires_at > NOW()`
      );

      for (const row of result.rows) {
        this.bannedIps.set(row.ip_address, {
          reason: row.reason,
          bannedAt: new Date(row.banned_at).getTime(),
          expiresAt: row.permanent ? Infinity : new Date(row.expires_at).getTime(),
          permanent: row.permanent,
        });
      }

      log.info({ loaded: result.rows.length }, 'Loaded existing bans from database');
    } catch (err) {
      log.warn({ err: err.message }, 'Failed to load bans from DB');
    }
  }

  _cleanup() {
    const now = Date.now();
    let removed = 0;

    for (const [ip, ban] of this.bannedIps) {
      if (!ban.permanent && now > ban.expiresAt) {
        this.bannedIps.delete(ip);
        removed++;
      }
    }

    // Clean stale share tracking
    for (const [ip, tracking] of this.shareTracking) {
      if (now - tracking.lastReset > this.checkWindow * 2) {
        this.shareTracking.delete(ip);
      }
    }

    if (removed > 0) {
      log.debug({ removed }, 'Expired bans cleaned up');
    }
  }
}

module.exports = BanningManager;
