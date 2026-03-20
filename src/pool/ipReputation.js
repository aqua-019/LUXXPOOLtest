/**
 * LUXXPOOL v0.7.0 — IP Reputation System
 * ═══════════════════════════════════════════════════════════
 * Behavioral scoring (0-100) per IP address with subnet tracking.
 * Informed by historical attack patterns:
 *   - GiveMeCoins SQL injection from single IP (2013)
 *   - TeamDoge DDoS with 200K+ IP addresses (2014)
 *   - Yiimp multi-pool simultaneous compromise (2017)
 *   - NiceHash spear-phishing lateral movement (2017)
 *
 * Score starts at 50 (neutral):
 *   - Good behavior increases score toward 100
 *   - Bad behavior decreases score toward 0
 *   - Auto-reject connections from IPs scoring <10
 *   - Decay toward 50 over time (1 point/hour)
 *   - Subnet /24 aggregate tracking for coordinated attacks
 */

const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');

const log = createLogger('ip-reputation');

class IpReputation extends EventEmitter {
  /**
   * @param {object} deps - { db, auditLog }
   * @param {object} opts
   */
  constructor(deps = {}, opts = {}) {
    super();

    this.db = deps.db;
    this.auditLog = deps.auditLog;

    this.rejectThreshold = opts.rejectThreshold || 10;
    this.subnetAlertThreshold = opts.subnetAlertThreshold || 30;
    this.decayIntervalMs = opts.decayIntervalMs || 3600000; // 1 hour
    this.persistIntervalMs = opts.persistIntervalMs || 300000; // 5 min

    // In-memory reputation scores
    this.scores = new Map(); // ip → { score, totalValid, totalInvalid, banCount, lastUpdated }
    this.dirty = new Set(); // IPs that need persisting

    this.decayTimer = null;
    this.persistTimer = null;
  }

  async start() {
    await this._load();
    this.decayTimer = setInterval(() => this._decay(), this.decayIntervalMs);
    this.persistTimer = setInterval(() => this._persist(), this.persistIntervalMs);
    log.info({ tracked: this.scores.size, rejectThreshold: this.rejectThreshold }, 'IP reputation system started');
  }

  stop() {
    if (this.decayTimer) clearInterval(this.decayTimer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    this._persist(); // final persist
  }

  /**
   * Check if an IP should be allowed to connect.
   * @returns {{ allowed: boolean, score: number }}
   */
  checkReputation(ip) {
    const normalizedIp = this._normalizeIp(ip);
    const entry = this._getOrCreate(normalizedIp);

    if (entry.score < this.rejectThreshold) {
      log.warn({ ip: normalizedIp, score: entry.score }, 'Connection rejected — low reputation');
      return { allowed: false, score: entry.score };
    }

    return { allowed: true, score: entry.score };
  }

  /**
   * Get current score for an IP.
   */
  getScore(ip) {
    const entry = this.scores.get(this._normalizeIp(ip));
    return entry ? entry.score : 50;
  }

  /**
   * Record valid shares (batch — called periodically, not per-share)
   */
  recordValidShares(ip, count = 1) {
    const normalizedIp = this._normalizeIp(ip);
    const entry = this._getOrCreate(normalizedIp);

    entry.totalValid += count;
    // +1 per 100 valid shares
    const bonus = Math.floor(count / 100);
    if (bonus > 0) {
      entry.score = Math.min(100, entry.score + bonus);
    }
    entry.lastUpdated = Date.now();
    this.dirty.add(normalizedIp);
  }

  /**
   * Record invalid share burst
   */
  recordInvalidShares(ip, count = 1) {
    const normalizedIp = this._normalizeIp(ip);
    const entry = this._getOrCreate(normalizedIp);

    entry.totalInvalid += count;
    // -5 per invalid share burst
    entry.score = Math.max(0, entry.score - 5);
    entry.lastUpdated = Date.now();
    this.dirty.add(normalizedIp);

    if (entry.score < this.rejectThreshold) {
      this.emit('reputationDepleted', normalizedIp, entry.score);
    }
  }

  /**
   * Record a protocol violation (-10)
   */
  recordViolation(ip) {
    const normalizedIp = this._normalizeIp(ip);
    const entry = this._getOrCreate(normalizedIp);

    entry.score = Math.max(0, entry.score - 10);
    entry.lastUpdated = Date.now();
    this.dirty.add(normalizedIp);

    if (entry.score < this.rejectThreshold) {
      this.emit('reputationDepleted', normalizedIp, entry.score);
    }
  }

  /**
   * Record a security alert (-20)
   */
  recordSecurityAlert(ip) {
    const normalizedIp = this._normalizeIp(ip);
    const entry = this._getOrCreate(normalizedIp);

    entry.score = Math.max(0, entry.score - 20);
    entry.lastUpdated = Date.now();
    this.dirty.add(normalizedIp);

    if (this.auditLog) {
      this.auditLog.security('reputation_drop', { ip: normalizedIp, score: entry.score, severity: 'WARN' });
    }

    if (entry.score < this.rejectThreshold) {
      this.emit('reputationDepleted', normalizedIp, entry.score);
    }
  }

  /**
   * Record a block found by this IP (+5)
   */
  recordBlockFound(ip) {
    const normalizedIp = this._normalizeIp(ip);
    const entry = this._getOrCreate(normalizedIp);

    entry.score = Math.min(100, entry.score + 5);
    entry.lastUpdated = Date.now();
    this.dirty.add(normalizedIp);
  }

  /**
   * Record a ban event
   */
  recordBan(ip) {
    const normalizedIp = this._normalizeIp(ip);
    const entry = this._getOrCreate(normalizedIp);

    entry.banCount++;
    entry.score = Math.max(0, entry.score - 15);
    entry.lastUpdated = Date.now();
    this.dirty.add(normalizedIp);
  }

  /**
   * Get ban count for progressive ban duration calculation.
   */
  getBanCount(ip) {
    const entry = this.scores.get(this._normalizeIp(ip));
    return entry ? entry.banCount : 0;
  }

  /**
   * Get subnet (/24) aggregate score.
   * @returns {{ avgScore: number, count: number, flagged: boolean }}
   */
  getSubnetScore(ip) {
    const subnet = this._getSubnet(ip);
    let totalScore = 0;
    let count = 0;

    for (const [addr, entry] of this.scores) {
      if (this._getSubnet(addr) === subnet) {
        totalScore += entry.score;
        count++;
      }
    }

    if (count === 0) return { avgScore: 50, count: 0, flagged: false };

    const avgScore = Math.round(totalScore / count);
    return { avgScore, count, flagged: avgScore < this.subnetAlertThreshold };
  }

  /**
   * Get all scores for admin dashboard (paginated).
   */
  getAll(limit = 100, offset = 0) {
    const entries = [];
    for (const [ip, entry] of this.scores) {
      entries.push({ ip, ...entry, subnet: this._getSubnet(ip) });
    }
    entries.sort((a, b) => a.score - b.score); // worst first
    return entries.slice(offset, offset + limit);
  }

  // ─── Internal ──────────────────────────────────────────

  _getOrCreate(ip) {
    if (!this.scores.has(ip)) {
      this.scores.set(ip, {
        score: 50,
        totalValid: 0,
        totalInvalid: 0,
        banCount: 0,
        lastUpdated: Date.now(),
      });
    }
    return this.scores.get(ip);
  }

  _normalizeIp(ip) {
    if (!ip) return 'unknown';
    return ip.replace(/^::ffff:/, '');
  }

  _getSubnet(ip) {
    const normalized = this._normalizeIp(ip);
    const parts = normalized.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
    return normalized; // IPv6 — return as-is
  }

  /**
   * Decay all scores toward 50 (neutral) at 1 point per interval.
   */
  _decay() {
    for (const [ip, entry] of this.scores) {
      if (entry.score > 50) {
        entry.score = Math.max(50, entry.score - 1);
        this.dirty.add(ip);
      } else if (entry.score < 50) {
        entry.score = Math.min(50, entry.score + 1);
        this.dirty.add(ip);
      }
    }

    // Remove stale entries (score=50, no activity in 24h)
    const staleThreshold = Date.now() - 86400000;
    for (const [ip, entry] of this.scores) {
      if (entry.score === 50 && entry.lastUpdated < staleThreshold && entry.banCount === 0) {
        this.scores.delete(ip);
        this.dirty.delete(ip);
      }
    }
  }

  async _load() {
    if (!this.db) return;

    try {
      const result = await this.db.query('SELECT * FROM ip_reputation');
      for (const row of result.rows) {
        const ip = row.ip_address.replace(/\/\d+$/, ''); // strip CIDR notation if any
        this.scores.set(ip, {
          score: row.score,
          totalValid: parseInt(row.total_valid) || 0,
          totalInvalid: parseInt(row.total_invalid) || 0,
          banCount: row.ban_count || 0,
          lastUpdated: new Date(row.last_updated).getTime(),
        });
      }
      log.info({ loaded: result.rows.length }, 'IP reputation scores loaded from database');
    } catch (err) {
      log.warn({ err: err.message }, 'Failed to load IP reputation from DB');
    }
  }

  async _persist() {
    if (!this.db || this.dirty.size === 0) return;

    const ips = Array.from(this.dirty);
    this.dirty.clear();

    for (const ip of ips) {
      const entry = this.scores.get(ip);
      if (!entry) continue;

      try {
        await this.db.query(
          `INSERT INTO ip_reputation (ip_address, score, last_updated, total_valid, total_invalid, ban_count, subnet)
           VALUES ($1, $2, NOW(), $3, $4, $5, $6)
           ON CONFLICT (ip_address) DO UPDATE SET
             score = $2, last_updated = NOW(), total_valid = $3, total_invalid = $4, ban_count = $5`,
          [ip, entry.score, entry.totalValid, entry.totalInvalid, entry.banCount, this._getSubnet(ip)]
        );
      } catch (err) {
        log.debug({ err: err.message, ip }, 'IP reputation persist failed');
      }
    }
  }
}

module.exports = IpReputation;
