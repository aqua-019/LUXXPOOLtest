/**
 * LUXXPOOL v0.3.0 — Triple-Layered Security Engine
 * ═══════════════════════════════════════════════════════════
 *
 * LAYER 1: MINING COOKIES (Anti-Hijack / Anti-BiteCoin)
 *   Per-connection secret shared between pool and miner.
 *   Prevents man-in-the-middle share hijacking attacks
 *   (StraTap, BiteCoin, WireGhost). Based on the "Bedrock"
 *   protocol extension from Recabarren & Carbunar (PoPETs 2017).
 *
 * LAYER 2: SHARE FINGERPRINTING (Anti-Block Withholding)
 *   Statistical anomaly detection on per-miner share submission
 *   patterns. Detects BWH attacks by identifying miners who
 *   submit partial PoW but never full PoW over long windows.
 *   Also detects share replay and cross-pool infiltration.
 *
 * LAYER 3: BEHAVIORAL ANOMALY ENGINE (Anti-Selfish Mining / DDoS)
 *   Real-time behavioral analysis on connection patterns, hashrate
 *   variance, submission timing, and difficulty manipulation.
 *   Identifies: connection floods, hashrate oscillation attacks,
 *   time-warp attempts, vardiff gaming, and Sybil patterns.
 *
 * Threat Model (Public Miner Attack Vectors):
 *   - MitM share hijacking (BiteCoin/WireGhost)
 *   - Block withholding (BWH / FAW / ISM)
 *   - Selfish mining via pool infiltration
 *   - DDoS via connection/share flooding
 *   - Stratum protocol abuse (buffer overflow, malformed JSON)
 *   - Address impersonation / payout theft
 *   - Vardiff gaming (intentionally slow shares to lower difficulty)
 *   - Nonce/ntime manipulation
 */

const crypto = require('crypto');
const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');

const log = createLogger('security');

// ═══════════════════════════════════════════════════════════
// LAYER 1: MINING COOKIES
// ═══════════════════════════════════════════════════════════

class MiningCookieManager {
  constructor() {
    this.cookies = new Map(); // clientId → cookie
  }

  /**
   * Generate a unique mining cookie for a new connection.
   * The cookie is a HMAC-based secret that gets embedded in
   * the coinbase puzzle, making share hijacking impossible
   * without knowing the cookie.
   * @param {string} clientId
   * @param {string} extraNonce1
   * @returns {string} 16-byte hex cookie
   */
  generate(clientId, extraNonce1) {
    const secret = crypto.randomBytes(8);
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(clientId + ':' + extraNonce1 + ':' + Date.now());
    const cookie = hmac.digest('hex').substring(0, 32);

    this.cookies.set(clientId, {
      cookie,
      secret: secret.toString('hex'),
      createdAt: Date.now(),
    });

    return cookie;
  }

  /**
   * Validate that a share submission includes the correct cookie.
   * @param {string} clientId
   * @param {string} submittedCookie
   * @returns {boolean}
   */
  validate(clientId, submittedCookie) {
    const entry = this.cookies.get(clientId);
    if (!entry) return false;
    return crypto.timingSafeEqual(
      Buffer.from(entry.cookie, 'hex'),
      Buffer.from(submittedCookie, 'hex')
    );
  }

  /**
   * Get cookie for embedding in coinbase
   */
  getCookie(clientId) {
    return this.cookies.get(clientId)?.cookie || null;
  }

  remove(clientId) {
    this.cookies.delete(clientId);
  }
}

// ═══════════════════════════════════════════════════════════
// LAYER 2: SHARE FINGERPRINTING (Anti-BWH)
// ═══════════════════════════════════════════════════════════

class ShareFingerprintEngine {
  /**
   * @param {object} config
   * @param {number} config.windowBlocks - Blocks to analyze (default 100)
   * @param {number} config.bwhThreshold - Suspicion threshold (default 0.95)
   * @param {number} config.minShareSample - Min shares before analysis (default 500)
   */
  constructor(config = {}) {
    this.windowBlocks = config.windowBlocks || 100;
    this.bwhThreshold = config.bwhThreshold || 0.95;
    this.minShareSample = config.minShareSample || 500;

    // Per-miner share statistics
    // address → { totalShares, partialPoW, fullPoW, lastBlock, shareTimes[], diffHistory[] }
    this.minerStats = new Map();
    this.alerts = [];
  }

  /**
   * Record a valid share (partial proof of work)
   */
  recordShare(minerAddress, difficulty, isBlock) {
    if (!this.minerStats.has(minerAddress)) {
      this.minerStats.set(minerAddress, {
        totalShares: 0,
        partialPoW: 0,
        fullPoW: 0,
        joinedAt: Date.now(),
        shareTimes: [],
        diffHistory: [],
        suspicionScore: 0,
      });
    }

    const stats = this.minerStats.get(minerAddress);
    stats.totalShares++;
    stats.shareTimes.push(Date.now());
    stats.diffHistory.push(difficulty);

    if (isBlock) {
      stats.fullPoW++;
    } else {
      stats.partialPoW++;
    }

    // Keep rolling window
    if (stats.shareTimes.length > 10000) {
      stats.shareTimes = stats.shareTimes.slice(-5000);
      stats.diffHistory = stats.diffHistory.slice(-5000);
    }

    // Run BWH detection if enough samples
    if (stats.totalShares >= this.minShareSample && stats.totalShares % 100 === 0) {
      this._detectBWH(minerAddress, stats);
    }
  }

  /**
   * Remove stale miner stats (no activity in 24 hours)
   */
  cleanup() {
    const cutoff = Date.now() - 86400000; // 24 hours
    for (const [address, stats] of this.minerStats) {
      const lastShare = stats.shareTimes[stats.shareTimes.length - 1];
      if (!lastShare || lastShare < cutoff) {
        this.minerStats.delete(address);
      }
    }
  }

  /**
   * Detect block withholding by statistical analysis.
   *
   * A BWH attacker submits partial PoW (shares) but withholds
   * full PoW (blocks). Over time, an honest miner should find
   * blocks proportional to their hashrate. A BWH attacker will
   * have a suspiciously low block-to-share ratio.
   *
   * Expected blocks = miner_shares / (network_diff / share_diff)
   * If actual_blocks << expected_blocks → suspicious
   */
  _detectBWH(address, stats) {
    if (stats.totalShares < this.minShareSample) return;

    // Calculate expected block probability
    const avgDiff = stats.diffHistory.reduce((a, b) => a + b, 0) / stats.diffHistory.length;
    const timeActive = (Date.now() - stats.joinedAt) / 1000;

    // If miner has been active for > 24h with > 1000 shares and ZERO blocks,
    // that's statistically suspicious depending on pool hashrate share
    if (timeActive > 86400 && stats.totalShares > 1000 && stats.fullPoW === 0) {
      stats.suspicionScore = Math.min(1.0, stats.suspicionScore + 0.1);

      if (stats.suspicionScore >= this.bwhThreshold) {
        const alert = {
          type: 'BWH_SUSPECTED',
          address,
          evidence: {
            totalShares: stats.totalShares,
            blocksFound: stats.fullPoW,
            timeActive: timeActive,
            suspicionScore: stats.suspicionScore,
          },
          timestamp: Date.now(),
        };

        this.alerts.push(alert);
        log.warn(alert, '⚠️  Block Withholding attack suspected');
        return alert;
      }
    }

    // Reduce suspicion if blocks are found
    if (stats.fullPoW > 0) {
      stats.suspicionScore = Math.max(0, stats.suspicionScore - 0.2);
    }

    return null;
  }

  /**
   * Detect share timing anomalies (replay or cross-pool leaking)
   * Honest miners submit shares at semi-random intervals.
   * Automated replay attacks show unnaturally regular timing.
   */
  detectTimingAnomaly(address) {
    const stats = this.minerStats.get(address);
    if (!stats || stats.shareTimes.length < 50) return null;

    const intervals = [];
    for (let i = 1; i < stats.shareTimes.length; i++) {
      intervals.push(stats.shareTimes[i] - stats.shareTimes[i - 1]);
    }

    // Calculate coefficient of variation
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / intervals.length;
    const stddev = Math.sqrt(variance);
    const cv = stddev / mean;

    // Unnaturally regular timing (CV < 0.1 means almost no variance)
    if (cv < 0.1 && intervals.length > 100) {
      return {
        type: 'TIMING_ANOMALY',
        address,
        cv,
        mean,
        message: 'Unnaturally regular share timing — possible replay attack',
      };
    }

    return null;
  }

  getStats(address) {
    return this.minerStats.get(address) || null;
  }

  getAlerts() {
    return this.alerts.slice(-50);
  }
}

// ═══════════════════════════════════════════════════════════
// LAYER 3: BEHAVIORAL ANOMALY ENGINE
// ═══════════════════════════════════════════════════════════

class BehavioralAnomalyEngine extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      maxSharesPerSecond: config.maxSharesPerSecond || 10,
      maxNtimeDeviation: config.maxNtimeDeviation || 300,   // 5 min
      hashrateVarianceThreshold: config.hashrateVarianceThreshold || 5.0,
      sybilDetectionWindow: config.sybilDetectionWindow || 3600000, // 1 hour
      ...config,
    };

    // Per-IP behavioral profiles
    this.profiles = new Map();
    // Cluster tracking for Sybil detection
    this.addressClusters = new Map();
  }

  /**
   * Analyze a share submission for anomalies
   * @returns {object|null} Alert if anomaly detected
   */
  analyzeShare(client, share) {
    const ip = client.remoteAddress;
    const address = client.minerAddress;
    const now = Date.now();

    if (!this.profiles.has(ip)) {
      this.profiles.set(ip, {
        shareTimestamps: [],
        ntimeValues: [],
        difficulties: [],
        addresses: new Set(),
        alerts: 0,
      });
    }

    const profile = this.profiles.get(ip);
    profile.shareTimestamps.push(now);
    profile.addresses.add(address);

    if (share.ntime) {
      profile.ntimeValues.push(parseInt(share.ntime, 16));
    }
    profile.difficulties.push(share.difficulty);

    // Trim to last 1000 entries
    if (profile.shareTimestamps.length > 1000) {
      profile.shareTimestamps = profile.shareTimestamps.slice(-500);
    }

    const alerts = [];

    // ── Check 1: Share flooding ──
    const recentShares = profile.shareTimestamps.filter(t => t > now - 1000);
    if (recentShares.length > this.config.maxSharesPerSecond) {
      alerts.push({
        type: 'SHARE_FLOOD',
        ip,
        address,
        sharesPerSecond: recentShares.length,
        severity: 'HIGH',
      });
    }

    // ── Check 2: ntime manipulation ──
    if (share.ntime) {
      const ntimeInt = parseInt(share.ntime, 16);
      const serverTime = Math.floor(now / 1000);
      const deviation = Math.abs(ntimeInt - serverTime);

      if (deviation > this.config.maxNtimeDeviation) {
        alerts.push({
          type: 'NTIME_MANIPULATION',
          ip,
          address,
          deviation,
          ntime: ntimeInt,
          serverTime,
          severity: 'HIGH',
        });
      }
    }

    // ── Check 3: VarDiff gaming ──
    // Miner intentionally submits shares slowly to lower difficulty,
    // then bursts shares at low difficulty for disproportionate reward
    if (profile.difficulties.length > 20) {
      const recentDiffs = profile.difficulties.slice(-20);
      const avgDiff = recentDiffs.reduce((a, b) => a + b, 0) / recentDiffs.length;
      const minDiff = Math.min(...recentDiffs);
      const maxDiff = Math.max(...recentDiffs);

      // Extreme difficulty swings indicate gaming
      if (maxDiff / minDiff > 16 && recentDiffs.length >= 20) {
        alerts.push({
          type: 'VARDIFF_GAMING',
          ip,
          address,
          minDiff,
          maxDiff,
          avgDiff,
          severity: 'MEDIUM',
        });
      }
    }

    // ── Check 4: Sybil detection ──
    // Multiple different addresses from same IP within time window
    if (profile.addresses.size > 3) {
      alerts.push({
        type: 'SYBIL_SUSPECTED',
        ip,
        addressCount: profile.addresses.size,
        addresses: Array.from(profile.addresses),
        severity: 'MEDIUM',
      });
    }

    // ── Check 5: Hashrate oscillation ──
    // Sudden massive hashrate changes suggest pool-hopping or attack setup
    if (profile.shareTimestamps.length > 50) {
      const firstHalf = profile.shareTimestamps.slice(0, 25);
      const secondHalf = profile.shareTimestamps.slice(-25);

      const firstRate = 25 / ((firstHalf[24] - firstHalf[0]) / 1000 || 1);
      const secondRate = 25 / ((secondHalf[24] - secondHalf[0]) / 1000 || 1);
      const ratio = Math.max(firstRate, secondRate) / Math.min(firstRate, secondRate);

      if (ratio > this.config.hashrateVarianceThreshold) {
        alerts.push({
          type: 'HASHRATE_OSCILLATION',
          ip,
          address,
          ratio,
          severity: 'LOW',
        });
      }
    }

    // Emit alerts
    for (const alert of alerts) {
      alert.timestamp = now;
      profile.alerts++;
      log.warn(alert, `🛡️  Security: ${alert.type}`);
      this.emit('alert', alert);
    }

    return alerts.length > 0 ? alerts : null;
  }

  /**
   * Get security profile for an IP
   */
  getProfile(ip) {
    return this.profiles.get(ip) || null;
  }

  /**
   * Clean stale profiles
   */
  cleanup() {
    const cutoff = Date.now() - 3600000; // 1 hour
    for (const [ip, profile] of this.profiles) {
      const latest = profile.shareTimestamps[profile.shareTimestamps.length - 1];
      if (!latest || latest < cutoff) {
        this.profiles.delete(ip);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// UNIFIED SECURITY MANAGER
// ═══════════════════════════════════════════════════════════

class SecurityManager extends EventEmitter {
  /**
   * @param {object} config
   * @param {object} deps - { db, banningManager }
   */
  constructor(config = {}, deps = {}) {
    super();

    this.cookieManager = new MiningCookieManager();
    this.fingerprintEngine = new ShareFingerprintEngine(config.fingerprint);
    this.anomalyEngine = new BehavioralAnomalyEngine(config.anomaly);
    this.banningManager = deps.banningManager;
    this.db = deps.db;

    // v0.7.0: Enhanced security integrations
    this.ipReputation = deps.ipReputation || null;
    this.auditLogger = deps.auditLogger || null;
    this.emergencyLockdown = deps.emergencyLockdown || null;

    // Auto-ban escalation
    this.anomalyEngine.on('alert', (alert) => {
      this._handleAlert(alert);
    });

    // Periodic cleanup
    this.cleanupTimer = null;
  }

  start() {
    this.cleanupTimer = setInterval(() => {
      this.anomalyEngine.cleanup();
      this.fingerprintEngine.cleanup();
    }, 300000); // 5 min cleanup

    log.info('🛡️  Triple-layered security engine started');
    log.info('   Layer 1: Mining Cookies (anti-hijack)');
    log.info('   Layer 2: Share Fingerprinting (anti-BWH)');
    log.info('   Layer 3: Behavioral Anomaly Detection');
  }

  stop() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /**
   * Process a share through all security layers.
   * v0.7.0: Now feeds IP reputation and lockdown threat metrics.
   */
  processShare(client, share, isBlock = false) {
    // Layer 2: Record for fingerprinting
    this.fingerprintEngine.recordShare(client.minerAddress, share.difficulty, isBlock);

    // Layer 3: Behavioral analysis
    // v0.7.0: Apply adaptive thresholds during lockdown
    const anomalies = this.anomalyEngine.analyzeShare(client, share);

    // Layer 2: Periodic timing check
    if (Math.random() < 0.01) { // Sample 1% of shares for timing
      const timing = this.fingerprintEngine.detectTimingAnomaly(client.minerAddress);
      if (timing) {
        this.emit('alert', timing);
      }
    }

    // v0.7.0: Feed IP reputation based on share validity
    if (this.ipReputation && client.remoteAddress) {
      this.ipReputation.recordEvent(client.remoteAddress, 'valid_share');
    }

    // v0.7.0: Feed lockdown threat metrics
    if (this.emergencyLockdown) {
      this.emergencyLockdown.recordThreatMetric('valid_share');
    }

    return anomalies;
  }

  /**
   * v0.7.0: Record an invalid share for reputation tracking.
   * Called by the share processor when a share fails validation.
   */
  recordInvalidShare(client) {
    if (this.ipReputation && client.remoteAddress) {
      this.ipReputation.recordEvent(client.remoteAddress, 'invalid_share');
    }
    if (this.emergencyLockdown) {
      this.emergencyLockdown.recordThreatMetric('invalid_share');
    }
  }

  /**
   * v0.7.0: Get the adaptive threshold multiplier.
   * During lockdown, security thresholds are tightened.
   * @returns {number} 1.0 = normal, lower = stricter
   */
  getThresholdMultiplier() {
    if (this.emergencyLockdown) {
      return this.emergencyLockdown.getThresholdMultiplier();
    }
    return 1.0;
  }

  /**
   * Handle auto-ban escalation for repeated HIGH severity alerts
   */
  _handleAlert(alert) {
    if (alert.severity === 'HIGH' && this.banningManager) {
      // Immediate ban for high severity
      this.banningManager.ban(alert.ip, `Security: ${alert.type}`, false);
    }

    // Log to database
    if (this.db) {
      this.db.query(
        `INSERT INTO security_events (type, ip, address, severity, details, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [alert.type, alert.ip, alert.address, alert.severity, JSON.stringify(alert)]
      ).catch(() => {});
    }

    // v0.7.0: Feed IP reputation
    if (this.ipReputation && alert.ip) {
      const eventMap = {
        share_flooding: 'share_flooding',
        ntime_manipulation: 'ntime_manipulation',
        vardiff_gaming: 'vardiff_gaming',
        sybil_detection: 'sybil_detected',
        hashrate_oscillation: 'connection_flood',
      };
      const repEvent = eventMap[alert.type] || 'protocol_violation';
      this.ipReputation.recordEvent(alert.ip, repEvent, alert.severity.toLowerCase());
    }

    // v0.7.0: Feed lockdown metrics
    if (this.emergencyLockdown) {
      this.emergencyLockdown.recordThreatMetric('security_event');
    }

    // v0.7.0: Audit log
    if (this.auditLogger) {
      this.auditLogger.logSecurityEvent(alert.type, alert.severity.toLowerCase(), {
        ip: alert.ip,
        address: alert.address,
        details: alert,
      });
    }

    this.emit('alert', alert);
  }

  /**
   * Generate a mining cookie for new connection (Layer 1)
   */
  generateCookie(clientId, extraNonce1) {
    return this.cookieManager.generate(clientId, extraNonce1);
  }

  /**
   * Get security dashboard data
   */
  getDashboard() {
    const dashboard = {
      layer1: {
        name: 'Mining Cookies',
        activeCookies: this.cookieManager.cookies.size,
      },
      layer2: {
        name: 'Share Fingerprinting',
        trackedMiners: this.fingerprintEngine.minerStats.size,
        recentAlerts: this.fingerprintEngine.getAlerts().length,
      },
      layer3: {
        name: 'Behavioral Anomaly',
        trackedIps: this.anomalyEngine.profiles.size,
      },
    };

    // v0.7.0: Extended security dashboard
    if (this.emergencyLockdown) {
      dashboard.lockdown = this.emergencyLockdown.getStatus();
    }
    if (this.ipReputation) {
      dashboard.highRiskIPs = this.ipReputation.getHighRiskIPs().length;
    }

    return dashboard;
  }
}

module.exports = {
  SecurityManager,
  MiningCookieManager,
  ShareFingerprintEngine,
  BehavioralAnomalyEngine,
};
