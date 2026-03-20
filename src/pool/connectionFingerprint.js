/**
 * LUXXPOOL v0.7.0 — Connection Fingerprinting
 * ═══════════════════════════════════════════════════════════
 * Botnet and Sybil cluster detection via connection behavior hashing.
 *
 * Security Context:
 *   - Synology NAS botnet (2014): 500M DOGE mined via coordinated
 *     malware on consumer NAS devices, all connecting to private pools
 *   - Sybil attacks amplify BWH, FAW, ISM attacks by distributing
 *     attacker hashrate across many accounts
 *   - Eligius BWH attack (2014) detectable only because attacker
 *     used just 2 accounts — Sybil-distributed would be invisible
 *
 * Fingerprint Components:
 *   1. Subscribe→authorize timing (consistent in botnets)
 *   2. First share delay after auth
 *   3. Share submission interval variance
 *   4. User-agent string
 *   5. Protocol message ordering
 *
 * Clusters are groups of connections with near-identical fingerprints,
 * indicating coordinated/automated behavior.
 */

const crypto = require('crypto');
const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');

const log = createLogger('fingerprint');

class ConnectionFingerprint extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.clusterThreshold - Min connections to form cluster (default 5)
   * @param {number} opts.similarityThreshold - Fingerprint similarity for clustering (0-1, default 0.85)
   * @param {number} opts.cleanupIntervalMs - Cleanup stale data interval (default 10min)
   */
  constructor(opts = {}) {
    super();

    this.clusterThreshold = opts.clusterThreshold || 5;
    this.similarityThreshold = opts.similarityThreshold || 0.85;
    this.cleanupIntervalMs = opts.cleanupIntervalMs || 600000;

    // Active connection fingerprints: clientId → FingerprintProfile
    this.profiles = new Map();

    // Fingerprint clusters: hash → { count, ips: Set, addresses: Set, firstSeen }
    this.clusters = new Map();

    this.cleanupTimer = null;
  }

  start() {
    this.cleanupTimer = setInterval(() => this._cleanup(), this.cleanupIntervalMs);
    log.info({ clusterThreshold: this.clusterThreshold }, 'Connection fingerprinting started');
  }

  stop() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /**
   * Begin tracking a new connection.
   * Called on mining.subscribe.
   */
  onSubscribe(clientId, ip, userAgent) {
    this.profiles.set(clientId, {
      ip: this._normalizeIp(ip),
      userAgent: userAgent || 'unknown',
      subscribeTime: Date.now(),
      authorizeTime: null,
      firstShareTime: null,
      shareIntervals: [],
      lastShareTime: null,
      messageOrder: ['subscribe'],
      fingerprint: null,
    });
  }

  /**
   * Record authorization event.
   */
  onAuthorize(clientId, address) {
    const profile = this.profiles.get(clientId);
    if (!profile) return;

    profile.authorizeTime = Date.now();
    profile.address = address;
    profile.messageOrder.push('authorize');
  }

  /**
   * Record share submission.
   */
  onShare(clientId) {
    const profile = this.profiles.get(clientId);
    if (!profile) return;

    const now = Date.now();

    if (!profile.firstShareTime) {
      profile.firstShareTime = now;
      profile.messageOrder.push('first_share');
    }

    if (profile.lastShareTime) {
      const interval = now - profile.lastShareTime;
      profile.shareIntervals.push(interval);

      // Keep last 50 intervals
      if (profile.shareIntervals.length > 50) {
        profile.shareIntervals = profile.shareIntervals.slice(-50);
      }
    }
    profile.lastShareTime = now;

    // Generate fingerprint after sufficient data (10+ shares)
    if (profile.shareIntervals.length >= 10 && !profile.fingerprint) {
      this._generateFingerprint(clientId, profile);
    }
  }

  /**
   * Handle disconnect — finalize and check clusters.
   */
  onDisconnect(clientId) {
    const profile = this.profiles.get(clientId);
    if (profile && !profile.fingerprint && profile.shareIntervals.length >= 5) {
      this._generateFingerprint(clientId, profile);
    }
    this.profiles.delete(clientId);
  }

  /**
   * Get cluster data for admin dashboard.
   */
  getClusters() {
    const result = [];
    for (const [hash, cluster] of this.clusters) {
      if (cluster.count >= this.clusterThreshold) {
        result.push({
          hash: hash.substring(0, 12),
          count: cluster.count,
          ips: Array.from(cluster.ips),
          addresses: Array.from(cluster.addresses),
          firstSeen: cluster.firstSeen,
          suspicious: true,
        });
      }
    }
    return result.sort((a, b) => b.count - a.count);
  }

  /**
   * Get active profile count.
   */
  getActiveCount() {
    return this.profiles.size;
  }

  // ─── Internal ──────────────────────────────────────────

  /**
   * Generate a behavioral fingerprint hash from connection profile.
   * Quantizes timing values into buckets to group similar behavior.
   */
  _generateFingerprint(clientId, profile) {
    // Quantize timing into buckets
    const subToAuth = profile.authorizeTime && profile.subscribeTime
      ? this._quantize(profile.authorizeTime - profile.subscribeTime, 100) // 100ms buckets
      : 'none';

    const authToFirstShare = profile.firstShareTime && profile.authorizeTime
      ? this._quantize(profile.firstShareTime - profile.authorizeTime, 1000) // 1s buckets
      : 'none';

    // Share interval statistics
    let avgInterval = 'none';
    let intervalVariance = 'none';
    if (profile.shareIntervals.length >= 5) {
      const mean = profile.shareIntervals.reduce((a, b) => a + b, 0) / profile.shareIntervals.length;
      avgInterval = this._quantize(mean, 500); // 500ms buckets

      const variance = profile.shareIntervals.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / profile.shareIntervals.length;
      const cv = Math.sqrt(variance) / mean; // coefficient of variation
      intervalVariance = this._quantize(cv * 1000, 100); // quantized CV
    }

    // Normalize user-agent (strip version numbers for grouping)
    const normalizedAgent = (profile.userAgent || 'unknown')
      .replace(/[\d.]+/g, 'X')
      .toLowerCase()
      .substring(0, 50);

    // Build fingerprint string and hash it
    const fpString = [
      `sub2auth:${subToAuth}`,
      `auth2share:${authToFirstShare}`,
      `avgInt:${avgInterval}`,
      `intVar:${intervalVariance}`,
      `agent:${normalizedAgent}`,
    ].join('|');

    const hash = crypto.createHash('sha256').update(fpString).digest('hex');
    profile.fingerprint = hash;

    // Update cluster
    if (!this.clusters.has(hash)) {
      this.clusters.set(hash, {
        count: 0,
        ips: new Set(),
        addresses: new Set(),
        firstSeen: Date.now(),
      });
    }

    const cluster = this.clusters.get(hash);
    cluster.count++;
    cluster.ips.add(profile.ip);
    if (profile.address) cluster.addresses.add(profile.address);

    // Check for suspicious cluster
    if (cluster.count >= this.clusterThreshold && cluster.ips.size >= 3) {
      log.warn({
        fingerprint: hash.substring(0, 12),
        connections: cluster.count,
        uniqueIps: cluster.ips.size,
        addresses: cluster.addresses.size,
      }, 'Suspicious connection cluster detected — possible botnet/Sybil');

      this.emit('clusterDetected', {
        hash: hash.substring(0, 12),
        count: cluster.count,
        ips: Array.from(cluster.ips),
        addresses: Array.from(cluster.addresses),
      });
    }
  }

  /**
   * Quantize a value into buckets for fingerprint grouping.
   */
  _quantize(value, bucketSize) {
    return Math.round(value / bucketSize) * bucketSize;
  }

  _normalizeIp(ip) {
    if (!ip) return 'unknown';
    return ip.replace(/^::ffff:/, '');
  }

  _cleanup() {
    // Remove clusters older than 6 hours with low count
    const cutoff = Date.now() - 21600000;
    for (const [hash, cluster] of this.clusters) {
      if (cluster.firstSeen < cutoff && cluster.count < this.clusterThreshold) {
        this.clusters.delete(hash);
      }
    }

    // Remove stale profiles (no activity in 30 min)
    const staleCutoff = Date.now() - 1800000;
    for (const [id, profile] of this.profiles) {
      const lastActivity = profile.lastShareTime || profile.subscribeTime;
      if (lastActivity < staleCutoff) {
        this.profiles.delete(id);
      }
    }
  }
}

module.exports = ConnectionFingerprint;
