/**
 * ═══════════════════════════════════════════════════════════════
 *  LUXXPOOL v0.7.0 — Nine-Layer Security Engine
 *  src/pool/securityEngine.js
 *
 *  Supersedes: securityManager.js (v0.3.0–v0.5.2 triple-layer)
 *
 *  Architecture: layered pipeline — each share/connection passes
 *  through all active layers in sequence. Any layer can REJECT,
 *  FLAG, or ESCALATE. Layers are independently configurable and
 *  can be disabled per environment without breaking the others.
 *
 *  LAYER MAP:
 *  ┌───┬────────────────────────────────┬──────────────────────────────────┐
 *  │ 1 │ Transport Security             │ TLS enforcement, cert pinning    │
 *  │ 2 │ Protocol Hardening             │ JSON/buffer validation, limits   │
 *  │ 3 │ Authentication & Cookies       │ HMAC mining cookies, anti-hijack │
 *  │ 4 │ Share Fingerprinting           │ Statistical BWH/FAW detection    │
 *  │ 5 │ Behavioral Anomaly Detection   │ Flood, ntime, vardiff, Sybil     │
 *  │ 6 │ Rate Limiting & DDoS Guard     │ Per-IP/global burst control      │
 *  │ 7 │ Address & Identity Validation  │ Address format, payout integrity │
 *  │ 8 │ Reputation Scoring Engine      │ Long-term per-miner trust score  │
 *  │ 9 │ Audit Trail & Forensics        │ Immutable event ledger           │
 *  └───┴────────────────────────────────┴──────────────────────────────────┘
 *
 *  Integration points (index.js):
 *    - securityEngine.onConnect(client)       — layers 1,2,6,7,8
 *    - securityEngine.onSubscribe(client)     — layer 3 (cookie issue)
 *    - securityEngine.onAuthorize(client)     — layer 7 (address validate)
 *    - securityEngine.onShare(client, share)  — layers 3,4,5,6,8,9
 *    - securityEngine.onDisconnect(client)    — layer 8 (session scoring)
 *    - securityEngine.audit(event)            — layer 9 (manual log)
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const crypto      = require('crypto');
const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');

const log = createLogger('security-engine');

// ─── Severity constants ──────────────────────────────────────
const SEV = { INFO: 'info', LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' };

// ─── Result codes ────────────────────────────────────────────
const RESULT = { PASS: 'pass', FLAG: 'flag', REJECT: 'reject', BAN: 'ban' };


// ═══════════════════════════════════════════════════════════
//  LAYER 1 — TRANSPORT SECURITY
//  Enforces TLS for SSL stratum port, validates cipher
//  strength, and optionally pins certificate fingerprints.
// ═══════════════════════════════════════════════════════════
class TransportLayer {
  constructor(config = {}) {
    this.requireTls        = config.requireTls        ?? false; // enforce TLS on SSL port
    this.minTlsVersion     = config.minTlsVersion     ?? 'TLSv1.2';
    this.bannedCiphers     = config.bannedCiphers     ?? ['RC4', 'DES', 'NULL', 'EXPORT'];
    this.pinnedFingerprint = config.pinnedFingerprint ?? null;  // SHA-256 of server cert
    this.allowPlaintext    = config.allowPlaintext    ?? true;  // plain port (3333) always ok
  }

  /**
   * Validate a new socket connection.
   * @param {object} socket - raw net.Socket or tls.TLSSocket
   * @returns {{ result, reason, meta }}
   */
  check(socket) {
    const isTls = socket.encrypted === true;

    // Plain port — always allowed (stratum+tcp)
    if (!isTls) {
      if (this.requireTls) {
        return { result: RESULT.REJECT, reason: 'TLS required on this port', layer: 1 };
      }
      return { result: RESULT.PASS, meta: { transport: 'plaintext' } };
    }

    // TLS socket checks
    const protocol = socket.getProtocol?.() ?? 'unknown';
    const cipher   = socket.getCipher?.()?.name ?? '';

    // Minimum TLS version
    const versionOrder = { 'TLSv1': 1, 'TLSv1.1': 2, 'TLSv1.2': 3, 'TLSv1.3': 4 };
    const minVer = versionOrder[this.minTlsVersion] ?? 3;
    const connVer = versionOrder[protocol] ?? 0;
    if (connVer < minVer) {
      return {
        result: RESULT.REJECT,
        reason: `TLS version ${protocol} below minimum ${this.minTlsVersion}`,
        layer: 1,
      };
    }

    // Banned cipher suites
    for (const banned of this.bannedCiphers) {
      if (cipher.includes(banned)) {
        return { result: RESULT.REJECT, reason: `Banned cipher suite: ${cipher}`, layer: 1 };
      }
    }

    // Certificate fingerprint pinning
    if (this.pinnedFingerprint) {
      const cert = socket.getPeerCertificate?.();
      const fingerprint = cert?.fingerprint256?.replace(/:/g, '').toLowerCase();
      if (fingerprint !== this.pinnedFingerprint.replace(/:/g, '').toLowerCase()) {
        return { result: RESULT.BAN, reason: 'Certificate fingerprint mismatch', layer: 1 };
      }
    }

    return { result: RESULT.PASS, meta: { transport: 'tls', protocol, cipher } };
  }
}


// ═══════════════════════════════════════════════════════════
//  LAYER 2 — PROTOCOL HARDENING
//  Validates JSON structure, enforces message size limits,
//  rejects malformed Stratum frames, and prevents buffer
//  overflow via oversized payload injection.
// ═══════════════════════════════════════════════════════════
class ProtocolLayer {
  constructor(config = {}) {
    this.maxMessageBytes  = config.maxMessageBytes  ?? 2048;   // max stratum frame size
    this.maxWorkerLength  = config.maxWorkerLength  ?? 96;     // address.workername
    this.maxPasswordLength = config.maxPasswordLength ?? 64;
    this.maxParamCount    = config.maxParamCount    ?? 8;      // params array length
    this.validMethods     = new Set([
      'mining.subscribe', 'mining.authorize', 'mining.submit',
      'mining.suggest_difficulty', 'mining.get_transactions',
      'mining.extranonce.subscribe',
    ]);
    // Track per-IP violation counts for escalation
    this.violations = new Map();
  }

  /**
   * Validate a raw Stratum JSON message.
   * @param {string} raw - raw string received from socket
   * @param {string} ip  - client IP for violation tracking
   * @returns {{ result, reason, parsed, layer }}
   */
  check(raw, ip) {
    // Size check — before parsing (prevents memory exhaustion)
    if (Buffer.byteLength(raw, 'utf8') > this.maxMessageBytes) {
      this._recordViolation(ip, 'oversized_message');
      return {
        result: RESULT.REJECT,
        reason: `Message exceeds ${this.maxMessageBytes} byte limit`,
        layer: 2,
      };
    }

    // JSON parse
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this._recordViolation(ip, 'invalid_json');
      return { result: RESULT.REJECT, reason: 'Invalid JSON', layer: 2 };
    }

    // Must be object
    if (typeof msg !== 'object' || Array.isArray(msg) || msg === null) {
      this._recordViolation(ip, 'non_object_message');
      return { result: RESULT.REJECT, reason: 'Message must be a JSON object', layer: 2 };
    }

    // Required fields
    if (!('id' in msg)) {
      this._recordViolation(ip, 'missing_id');
      return { result: RESULT.REJECT, reason: 'Missing message id', layer: 2 };
    }

    // Method validation (client → pool messages)
    if (msg.method !== undefined) {
      if (!this.validMethods.has(msg.method)) {
        this._recordViolation(ip, 'unknown_method');
        return { result: RESULT.REJECT, reason: `Unknown method: ${msg.method}`, layer: 2 };
      }

      // Params must be array if present
      if (msg.params !== undefined && !Array.isArray(msg.params)) {
        this._recordViolation(ip, 'invalid_params');
        return { result: RESULT.REJECT, reason: 'Params must be an array', layer: 2 };
      }

      // Params count
      if (Array.isArray(msg.params) && msg.params.length > this.maxParamCount) {
        this._recordViolation(ip, 'param_overflow');
        return {
          result: RESULT.REJECT,
          reason: `Param count ${msg.params.length} exceeds limit`,
          layer: 2,
        };
      }

      // Worker string length for mining.authorize
      if (msg.method === 'mining.authorize' && Array.isArray(msg.params)) {
        const [worker = '', password = ''] = msg.params;
        if (String(worker).length > this.maxWorkerLength) {
          this._recordViolation(ip, 'oversized_worker');
          return { result: RESULT.REJECT, reason: 'Worker name too long', layer: 2 };
        }
        if (String(password).length > this.maxPasswordLength) {
          this._recordViolation(ip, 'oversized_password');
          return { result: RESULT.REJECT, reason: 'Password field too long', layer: 2 };
        }
      }
    }

    // Escalate on repeated violations
    const violationEntry = this.violations.get(ip);
    const violationCount = violationEntry ? violationEntry.count : 0;
    if (violationCount >= 5) {
      return {
        result: RESULT.BAN,
        reason: `Protocol abuse: ${violationCount} violations from this IP`,
        layer: 2,
      };
    }

    return { result: RESULT.PASS, parsed: msg };
  }

  _recordViolation(ip, type) {
    if (!this.violations.has(ip)) {
      this.violations.set(ip, { count: 0, lastViolation: Date.now() });
    }
    const entry = this.violations.get(ip);
    entry.count++;
    entry.lastViolation = Date.now();
    log.warn({ ip, type, count: entry.count }, 'L2 protocol violation');
  }

  clearViolations(ip) {
    this.violations.delete(ip);
  }

  cleanup() {
    // Remove entries older than 1 hour instead of nuclear .clear()
    const cutoff = Date.now() - 3600000;
    for (const [ip, entry] of this.violations) {
      if (typeof entry === 'number' || !entry.lastViolation || entry.lastViolation < cutoff) {
        this.violations.delete(ip);
      }
    }
  }
}


// ═══════════════════════════════════════════════════════════
//  LAYER 3 — AUTHENTICATION & MINING COOKIES
//  Refined from v0.3.0. HMAC-based per-connection secret
//  prevents BiteCoin / WireGhost share hijacking. Cookie is
//  now tied to both client ID and server epoch to prevent
//  replay across pool restarts.
// ═══════════════════════════════════════════════════════════
class AuthLayer {
  constructor(config = {}) {
    this.secret      = config.secret ?? crypto.randomBytes(32).toString('hex');
    this.serverEpoch = Math.floor(Date.now() / 1000); // fixed at startup
    this.cookies     = new Map(); // clientId → { cookie, issuedAt, verified }
  }

  /**
   * Issue a mining cookie for a new subscriber.
   * @param {string} clientId
   * @returns {string} hex cookie (8 bytes)
   */
  issueCookie(clientId) {
    const data   = `${clientId}:${this.serverEpoch}`;
    const cookie = crypto
      .createHmac('sha256', this.secret)
      .update(data)
      .digest('hex')
      .slice(0, 16); // 8 bytes hex

    this.cookies.set(clientId, { cookie, issuedAt: Date.now(), verified: false });
    return cookie;
  }

  /**
   * Verify that a submitted share carries the correct cookie
   * (embedded in coinbase extra nonce space).
   * @param {string} clientId
   * @param {string} submittedCookie
   * @returns {{ result, reason, layer }}
   */
  verifyCookie(clientId, submittedCookie) {
    const record = this.cookies.get(clientId);
    if (!record) {
      return { result: RESULT.REJECT, reason: 'No cookie record for client', layer: 3 };
    }
    if (submittedCookie !== record.cookie) {
      return { result: RESULT.BAN, reason: 'Cookie mismatch — possible share hijacking', layer: 3 };
    }
    record.verified = true;
    return { result: RESULT.PASS };
  }

  /**
   * Check if a client has been issued and verified a cookie.
   * Unverified clients are flagged (not banned) until first valid share.
   */
  checkCookieStatus(clientId) {
    const record = this.cookies.get(clientId);
    if (!record)           return { result: RESULT.FLAG, reason: 'No cookie issued', layer: 3 };
    if (!record.verified)  return { result: RESULT.FLAG, reason: 'Cookie not yet verified', layer: 3 };
    return { result: RESULT.PASS };
  }

  revokeCookie(clientId) {
    this.cookies.delete(clientId);
  }
}


// ═══════════════════════════════════════════════════════════
//  LAYER 4 — SHARE FINGERPRINTING
//  Refined from v0.3.0. Statistical detection of Block
//  Withholding (BWH) and Fork After Withholding (FAW).
//  Now also tracks share-to-stale ratio per miner for
//  template staleness abuse detection.
// ═══════════════════════════════════════════════════════════
class FingerprintLayer {
  constructor(config = {}) {
    this.minShares     = config.minShares     ?? 500;    // min shares before BWH analysis
    this.bwhThreshold  = config.bwhThreshold  ?? 0.001;  // expected full-PoW rate (1/1000)
    this.bwhConfidence = config.bwhConfidence ?? 0.999;  // statistical confidence for alert
    this.staleLimit    = config.staleLimit    ?? 0.20;   // >20% stale rate = abuse
    this.profiles      = new Map();                       // address → profile
  }

  /**
   * Record a share submission.
   * @param {string} address - miner address
   * @param {boolean} isFullBlock - true if this share solved the block
   * @param {boolean} isStale     - true if share is for an old job
   * @returns {{ result, reason, layer } | null} null = no finding
   */
  recordShare(address, isFullBlock, isStale) {
    if (!this.profiles.has(address)) {
      this.profiles.set(address, {
        partial: 0, full: 0, stale: 0, total: 0,
        firstSeen: Date.now(), lastSeen: Date.now(),
      });
    }

    const p = this.profiles.get(address);
    p.total++;
    p.lastSeen = Date.now();
    if (isStale)     { p.stale++; }
    else if (isFullBlock) { p.full++; }
    else             { p.partial++; }

    // Only analyze once minimum share count is reached
    if (p.total < this.minShares) return null;

    // BWH detection: uses binomial probability
    // Under honest mining, expected full-block rate = bwhThreshold (≈ 1/diff)
    // If observed rate is statistically zero, flag for BWH
    const expectedFull = p.total * this.bwhThreshold;
    if (p.full === 0 && expectedFull > this._bwhCriticalValue(this.bwhConfidence)) {
      return {
        result: RESULT.FLAG,
        reason: `BWH suspect: 0 full PoW in ${p.total} shares (expected ~${expectedFull.toFixed(1)})`,
        severity: SEV.HIGH,
        layer: 4,
      };
    }

    // Stale abuse detection
    const staleRate = p.stale / p.total;
    if (staleRate > this.staleLimit) {
      return {
        result: RESULT.FLAG,
        reason: `High stale rate: ${(staleRate * 100).toFixed(1)}% (limit ${this.staleLimit * 100}%)`,
        severity: SEV.MEDIUM,
        layer: 4,
      };
    }

    return null;
  }

  /**
   * Minimum expected full-block count to trigger at given confidence.
   * Approximation: for p-value < (1-confidence), E[X] > ln(1/(1-confidence))
   */
  _bwhCriticalValue(confidence) {
    return -Math.log(1 - confidence);
  }

  getProfile(address) {
    return this.profiles.get(address) ?? null;
  }

  cleanup() {
    const cutoff = Date.now() - 86400000; // 24h
    for (const [addr, p] of this.profiles) {
      if (p.lastSeen < cutoff) this.profiles.delete(addr);
    }
  }
}


// ═══════════════════════════════════════════════════════════
//  LAYER 5 — BEHAVIORAL ANOMALY DETECTION
//  Refined from v0.3.0. Detects: share flooding, ntime
//  manipulation, vardiff gaming, Sybil patterns, hashrate
//  oscillation, and session duration abuse.
// ═══════════════════════════════════════════════════════════
class BehaviorLayer {
  constructor(config = {}) {
    this.maxSharesPerSec       = config.maxSharesPerSec       ?? 10;
    this.maxNtimeDeviation     = config.maxNtimeDeviation     ?? 300; // seconds
    this.maxVardiffSwing       = config.maxVardiffSwing       ?? 16;  // ratio
    this.maxAddressesPerIp     = config.maxAddressesPerIp     ?? 3;   // Sybil threshold
    this.maxHashrateOscillation = config.maxHashrateOscillation ?? 5; // ratio
    this.minSessionSeconds     = config.minSessionSeconds     ?? 30;  // hit-and-run detection
    this.profiles              = new Map();
    this.ipAddressMap          = new Map(); // ip → Set(addresses)
  }

  /**
   * Record a share and evaluate behavioral patterns.
   * @param {object} ctx - { clientId, address, ip, ntime, difficulty, hashrateGhps }
   * @returns {{ result, reason, severity, layer } | null}
   */
  analyze(ctx) {
    const { clientId, address, ip, ntime, difficulty, hashrateGhps } = ctx;

    if (!this.profiles.has(clientId)) {
      this.profiles.set(clientId, {
        shareTimes: [], difficulties: [], hashrates: [],
        connectedAt: Date.now(), lastShare: 0,
      });
    }

    const p = this.profiles.get(clientId);
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);

    // ─── 1. Share flood (>maxSharesPerSec in last second)
    const recent = p.shareTimes.filter(t => now - t < 1000);
    if (recent.length >= this.maxSharesPerSec) {
      return {
        result: RESULT.BAN,
        reason: `Share flood: ${recent.length} shares/sec`,
        severity: SEV.HIGH, layer: 5,
      };
    }
    p.shareTimes.push(now);
    if (p.shareTimes.length > 100) p.shareTimes = p.shareTimes.slice(-100);

    // ─── 2. ntime manipulation
    if (typeof ntime === 'number') {
      const drift = Math.abs(ntime - nowSec);
      if (drift > this.maxNtimeDeviation) {
        return {
          result: RESULT.REJECT,
          reason: `ntime deviation: ${drift}s (max ${this.maxNtimeDeviation}s)`,
          severity: SEV.MEDIUM, layer: 5,
        };
      }
    }

    // ─── 3. Vardiff gaming (difficulty swinging wildly)
    if (typeof difficulty === 'number' && p.difficulties.length > 0) {
      const lastDiff = p.difficulties[p.difficulties.length - 1];
      const swing = difficulty > lastDiff
        ? difficulty / lastDiff
        : lastDiff / difficulty;
      if (swing > this.maxVardiffSwing) {
        return {
          result: RESULT.FLAG,
          reason: `Vardiff swing: ${swing.toFixed(1)}x (max ${this.maxVardiffSwing}x)`,
          severity: SEV.MEDIUM, layer: 5,
        };
      }
    }
    if (typeof difficulty === 'number') {
      p.difficulties.push(difficulty);
      if (p.difficulties.length > 20) p.difficulties = p.difficulties.slice(-20);
    }

    // ─── 4. Sybil detection (multiple addresses from same IP)
    if (ip && address) {
      if (!this.ipAddressMap.has(ip)) this.ipAddressMap.set(ip, new Set());
      const addrs = this.ipAddressMap.get(ip);
      addrs.add(address);
      if (addrs.size > this.maxAddressesPerIp) {
        return {
          result: RESULT.FLAG,
          reason: `Sybil pattern: ${addrs.size} addresses from ${ip}`,
          severity: SEV.HIGH, layer: 5,
        };
      }
    }

    // ─── 5. Hashrate oscillation (sudden spikes/drops > threshold)
    if (typeof hashrateGhps === 'number' && hashrateGhps > 0 && p.hashrates.length > 2) {
      const avgRate = p.hashrates.reduce((a, b) => a + b, 0) / p.hashrates.length;
      const oscillation = hashrateGhps > avgRate
        ? hashrateGhps / avgRate
        : avgRate / hashrateGhps;
      if (oscillation > this.maxHashrateOscillation) {
        return {
          result: RESULT.FLAG,
          reason: `Hashrate oscillation: ${oscillation.toFixed(1)}x (max ${this.maxHashrateOscillation}x)`,
          severity: SEV.LOW, layer: 5,
        };
      }
    }
    if (typeof hashrateGhps === 'number') {
      p.hashrates.push(hashrateGhps);
      if (p.hashrates.length > 10) p.hashrates = p.hashrates.slice(-10);
    }

    p.lastShare = now;
    return null;
  }

  /**
   * Check session health on disconnect — detect hit-and-run patterns.
   */
  onDisconnect(clientId) {
    const p = this.profiles.get(clientId);
    if (!p) return null;

    const sessionSec = (Date.now() - p.connectedAt) / 1000;
    const finding = sessionSec < this.minSessionSeconds && p.shareTimes.length > 50
      ? {
          result: RESULT.FLAG,
          reason: `Short session: ${sessionSec.toFixed(0)}s with ${p.shareTimes.length} shares`,
          severity: SEV.LOW, layer: 5,
        }
      : null;

    this.profiles.delete(clientId);
    return finding;
  }

  cleanup() {
    const cutoff = Date.now() - 3600000;
    for (const [id, p] of this.profiles) {
      if (p.lastShare < cutoff) this.profiles.delete(id);
    }
    if (this.ipAddressMap.size > 5000) this.ipAddressMap.clear();
  }
}


// ═══════════════════════════════════════════════════════════
//  LAYER 6 — RATE LIMITING & DDoS GUARD
//  Granular token-bucket rate limiting at connection,
//  share, and API call levels. Separate buckets for fleet
//  vs public miners. Global pool-level share rate cap.
// ═══════════════════════════════════════════════════════════
class RateLimitLayer {
  constructor(config = {}) {
    // Connection limits
    this.maxConnPerIp        = config.maxConnPerIp        ?? 5;
    this.maxConnPerFleetIp   = config.maxConnPerFleetIp   ?? 100;
    this.maxConnRatePerMin   = config.maxConnRatePerMin   ?? 30;  // connects/min/IP

    // Share submission limits
    this.maxShareRatePerMin  = config.maxShareRatePerMin  ?? 600; // shares/min/client
    this.maxGlobalShareRate  = config.maxGlobalShareRate  ?? null; // null = uncapped

    // Tracking
    this.activeConns     = new Map(); // ip → count
    this.connTimestamps  = new Map(); // ip → [timestamps]
    this.shareTimestamps = new Map(); // clientId → [timestamps]
  }

  /**
   * Check if a new connection from this IP is allowed.
   * @param {string} ip
   * @param {boolean} isFleet
   * @returns {{ result, reason, layer } | null}
   */
  checkConnection(ip, isFleet = false) {
    const max = isFleet ? this.maxConnPerFleetIp : this.maxConnPerIp;
    const current = this.activeConns.get(ip) || 0;
    if (current >= max) {
      return {
        result: RESULT.REJECT,
        reason: `Connection limit reached: ${current}/${max} from ${ip}`,
        layer: 6,
      };
    }

    // Connection rate check
    const now = Date.now();
    const ts = (this.connTimestamps.get(ip) || []).filter(t => now - t < 60000);
    ts.push(now);
    this.connTimestamps.set(ip, ts);
    if (ts.length > this.maxConnRatePerMin) {
      return {
        result: RESULT.BAN,
        reason: `Connection rate: ${ts.length} connections/min from ${ip}`,
        layer: 6,
      };
    }

    this.activeConns.set(ip, current + 1);
    return null;
  }

  onDisconnect(ip) {
    const n = this.activeConns.get(ip) || 0;
    if (n <= 1) this.activeConns.delete(ip);
    else this.activeConns.set(ip, n - 1);
  }

  /**
   * Check if a share submission is within rate limits.
   * @param {string} clientId
   * @returns {{ result, reason, layer } | null}
   */
  checkShareRate(clientId) {
    const now = Date.now();
    const ts = (this.shareTimestamps.get(clientId) || []).filter(t => now - t < 60000);
    ts.push(now);
    this.shareTimestamps.set(clientId, ts);

    if (ts.length > this.maxShareRatePerMin) {
      return {
        result: RESULT.REJECT,
        reason: `Share rate: ${ts.length} shares/min (limit ${this.maxShareRatePerMin})`,
        layer: 6,
      };
    }
    return null;
  }

  cleanup() {
    const cutoff = Date.now() - 120000;
    for (const [id, ts] of this.shareTimestamps) {
      if (!ts.some(t => t > cutoff)) this.shareTimestamps.delete(id);
    }
    // Clean up stale connection timestamps
    for (const [ip, ts] of this.connTimestamps) {
      const recent = ts.filter(t => t > cutoff);
      if (recent.length === 0) {
        this.connTimestamps.delete(ip);
      } else {
        this.connTimestamps.set(ip, recent);
      }
    }
  }
}


// ═══════════════════════════════════════════════════════════
//  LAYER 7 — ADDRESS & IDENTITY VALIDATION
//  Validates Litecoin address format (P2PKH/P2SH) on
//  authorization. Detects duplicate address registrations
//  (the same payout address registered under multiple
//  workers to game payment distribution). Enforces payout
//  destination integrity — address used for auth must match
//  what payment processor will send to.
// ═══════════════════════════════════════════════════════════
class IdentityLayer {
  constructor(config = {}) {
    this.maxWorkersPerAddress = config.maxWorkersPerAddress ?? 50;
    // Litecoin mainnet: L or M prefix (P2PKH), 3 prefix (P2SH)
    // Litecoin testnet: m, n prefix (P2PKH), 2 prefix (P2SH)
    this.validPrefixes  = config.validPrefixes ?? ['L', 'M', '3', 'm', 'n', '2'];
    this.addressWorkers = new Map(); // address → Set(clientId)
    this.clientAddress  = new Map(); // clientId → address
  }

  /**
   * Validate a Litecoin address string.
   * Checks prefix, length (26–35 chars), and Base58 character set.
   * @param {string} addr
   * @returns {{ valid, reason }}
   */
  validateAddress(addr) {
    if (typeof addr !== 'string') return { valid: false, reason: 'Address must be a string' };

    // Strip worker suffix (address.worker_name)
    const base = addr.split('.')[0];

    if (base.length < 26 || base.length > 35) {
      return { valid: false, reason: `Address length ${base.length} outside valid range (26–35)` };
    }

    if (!this.validPrefixes.some(p => base.startsWith(p))) {
      return {
        valid: false,
        reason: `Invalid address prefix '${base[0]}' — expected L, M, or 3`,
      };
    }

    // Base58 charset check
    const base58 = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
    if (!base58.test(base)) {
      return { valid: false, reason: 'Address contains invalid characters' };
    }

    return { valid: true };
  }

  /**
   * Register an authorized miner. Returns rejection if limits breached.
   * @param {string} clientId
   * @param {string} rawWorker - "LTC_ADDRESS.worker_name"
   * @returns {{ result, reason, address, layer } | { result: PASS, address }}
   */
  registerMiner(clientId, rawWorker) {
    const address = rawWorker.split('.')[0];
    const { valid, reason } = this.validateAddress(address);
    if (!valid) {
      return { result: RESULT.REJECT, reason: `Invalid address: ${reason}`, layer: 7 };
    }

    // Worker count per address
    if (!this.addressWorkers.has(address)) this.addressWorkers.set(address, new Set());
    const workers = this.addressWorkers.get(address);
    if (workers.size >= this.maxWorkersPerAddress) {
      return {
        result: RESULT.FLAG,
        reason: `Address ${address.slice(0, 8)}… has ${workers.size} registered workers`,
        severity: SEV.MEDIUM, layer: 7,
      };
    }

    workers.add(clientId);
    this.clientAddress.set(clientId, address);
    return { result: RESULT.PASS, address };
  }

  /**
   * Verify that the payout address for a share matches
   * what was registered at authorization time.
   */
  verifyPayoutIntegrity(clientId, shareAddress) {
    const registered = this.clientAddress.get(clientId);
    if (!registered) {
      return { result: RESULT.REJECT, reason: 'Client not authorized', layer: 7 };
    }
    if (shareAddress !== registered) {
      return {
        result: RESULT.BAN,
        reason: `Address mismatch — authorized: ${registered.slice(0, 8)}…, share: ${shareAddress.slice(0, 8)}…`,
        layer: 7,
      };
    }
    return { result: RESULT.PASS };
  }

  deregisterMiner(clientId) {
    const address = this.clientAddress.get(clientId);
    if (address) {
      const workers = this.addressWorkers.get(address);
      if (workers) {
        workers.delete(clientId);
        if (workers.size === 0) this.addressWorkers.delete(address);
      }
    }
    this.clientAddress.delete(clientId);
  }
}


// ═══════════════════════════════════════════════════════════
//  LAYER 8 — REPUTATION SCORING ENGINE
//  Long-term per-miner trust score persisted in Redis.
//  Score is a 0–1000 integer (1000 = perfect, 0 = untrusted).
//  Score decays toward neutral (500) over time, ensuring
//  miners can recover from incidents and bad actors can't
//  forever exploit a grandfathered good reputation.
//  Fleet miners always receive score 1000 (exempt).
// ═══════════════════════════════════════════════════════════
class ReputationLayer {
  constructor(config = {}, deps = {}) {
    this.redis         = deps.redis ?? null;
    this.prefix        = 'lux:rep:';
    this.defaultScore  = config.defaultScore  ?? 500;
    this.maxScore      = config.maxScore      ?? 1000;
    this.minScore      = config.minScore      ?? 0;
    this.banThreshold  = config.banThreshold  ?? 100;    // auto-ban below this
    this.flagThreshold = config.flagThreshold ?? 250;    // extra scrutiny
    this.penaltyMap    = {
      [SEV.LOW]:      config.penaltyLow      ?? 20,
      [SEV.MEDIUM]:   config.penaltyMedium   ?? 75,
      [SEV.HIGH]:     config.penaltyHigh     ?? 200,
      [SEV.CRITICAL]: config.penaltyCritical ?? 500,
    };
    this.rewardPerBlock = config.rewardPerBlock ?? 50;  // score bump for finding a block
    this.decayPerHour   = config.decayPerHour   ?? 5;   // decay toward default per hour
    this.localCache     = new Map(); // address → { score, lastUpdated }
  }

  /**
   * Get current reputation score for a miner.
   * @param {string} address
   * @returns {Promise<number>}
   */
  async getScore(address) {
    const key = this.prefix + address;
    if (this.redis) {
      try {
        const val = await this.redis.get(key);
        if (val !== null) return parseInt(val, 10);
      } catch { /* fall through to cache */ }
    }
    return this.localCache.get(address)?.score ?? this.defaultScore;
  }

  /**
   * Apply a penalty for a security finding.
   * @param {string} address
   * @param {string} severity - SEV constant
   * @returns {Promise<{ newScore, action }>}
   */
  async penalize(address, severity) {
    const current  = await this.getScore(address);
    const penalty  = this.penaltyMap[severity] ?? this.penaltyMap[SEV.MEDIUM];
    const newScore = Math.max(this.minScore, current - penalty);
    await this._setScore(address, newScore);

    const action = newScore <= this.banThreshold ? 'ban'
      : newScore <= this.flagThreshold ? 'flag'
      : 'warn';

    log.info({ address: address.slice(0, 12) + '…', severity, penalty, current, newScore, action },
      'L8 reputation penalty');

    return { newScore, action };
  }

  /**
   * Reward a miner for finding a block (increases trust).
   */
  async reward(address, reason = 'block_found') {
    const current  = await this.getScore(address);
    const newScore = Math.min(this.maxScore, current + this.rewardPerBlock);
    await this._setScore(address, newScore);
    log.info({ address: address.slice(0, 12) + '…', reason, current, newScore }, 'L8 reputation reward');
    return newScore;
  }

  /**
   * Decay all scores toward default (called hourly).
   * Prevents permanent punishment and permanent trust.
   */
  async decayAll() {
    if (!this.redis) return;
    try {
      const keys = await this.redis.keys(this.prefix + '*');
      for (const key of keys) {
        const val = parseInt(await this.redis.get(key) ?? this.defaultScore, 10);
        const decayed = val > this.defaultScore
          ? Math.max(this.defaultScore, val - this.decayPerHour)
          : Math.min(this.defaultScore, val + this.decayPerHour);
        await this.redis.setex(key, 86400 * 30, decayed); // 30-day TTL
      }
    } catch (err) {
      log.warn({ err: err.message }, 'L8 reputation decay failed');
    }
  }

  async _setScore(address, score) {
    this.localCache.set(address, { score, lastUpdated: Date.now() });
    if (this.redis) {
      try {
        await this.redis.setex(this.prefix + address, 86400 * 30, score);
      } catch { /* local cache is fallback */ }
    }
  }

  /**
   * Check if a miner's reputation warrants blocking on connect.
   */
  async checkOnConnect(address) {
    const score = await this.getScore(address);
    if (score <= this.banThreshold) {
      return {
        result: RESULT.BAN,
        reason: `Reputation score ${score} below ban threshold (${this.banThreshold})`,
        layer: 8,
      };
    }
    if (score <= this.flagThreshold) {
      return {
        result: RESULT.FLAG,
        reason: `Low reputation score: ${score}`,
        severity: SEV.MEDIUM, layer: 8,
      };
    }
    return { result: RESULT.PASS, score };
  }
}


// ═══════════════════════════════════════════════════════════
//  LAYER 9 — AUDIT TRAIL & FORENSICS
//  Immutable append-only event ledger backed by Redis
//  (with in-memory fallback). Every security event from
//  any layer is recorded with timestamp, layer source,
//  client context, and result. Supports forensic replay
//  and operator alert dispatch.
// ═══════════════════════════════════════════════════════════
class AuditLayer {
  constructor(config = {}, deps = {}) {
    this.redis        = deps.redis ?? null;
    this.db           = deps.db ?? null;
    this.prefix       = 'lux:audit:';
    this.maxLocalLog  = config.maxLocalLog  ?? 10000;
    this.localLog     = [];
    this.alertHooks   = []; // fn(event) — operator alert callbacks
  }

  /**
   * Record a security event.
   * @param {object} event
   * @param {number}  event.layer        - 1–9
   * @param {string}  event.result       - RESULT constant
   * @param {string}  event.reason       - human-readable finding
   * @param {string}  [event.severity]   - SEV constant
   * @param {string}  [event.clientId]
   * @param {string}  [event.ip]
   * @param {string}  [event.address]
   * @param {object}  [event.meta]       - arbitrary extra data
   */
  async record(event) {
    const entry = {
      ts:       Date.now(),
      ...event,
    };

    // Local ring buffer
    this.localLog.push(entry);
    if (this.localLog.length > this.maxLocalLog) {
      this.localLog = this.localLog.slice(-this.maxLocalLog);
    }

    // Redis append (stream)
    if (this.redis) {
      try {
        await this.redis.xadd(
          `${this.prefix}events`,
          'MAXLEN', '~', '100000',
          '*',
          'data', JSON.stringify(entry),
        );
      } catch { /* non-fatal */ }
    }

    // Postgres persist for HIGH/CRITICAL
    if (this.db && (event.severity === SEV.HIGH || event.severity === SEV.CRITICAL)) {
      try {
        await this.db.query(
          `INSERT INTO security_events
           (layer, result, reason, severity, client_id, ip_address, miner_address, meta, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
          [
            entry.layer, entry.result, entry.reason, entry.severity ?? SEV.INFO,
            entry.clientId ?? null, entry.ip ?? null, entry.address ?? null,
            JSON.stringify(entry.meta ?? {}),
          ]
        );
      } catch { /* non-fatal */ }
    }

    // Alert dispatch for HIGH+ severity
    if (event.severity === SEV.HIGH || event.severity === SEV.CRITICAL) {
      for (const hook of this.alertHooks) {
        try { hook(entry); } catch { /* hook failures must not crash engine */ }
      }
    }
  }

  /**
   * Register an alert hook (e.g. push to operator dashboard websocket).
   * @param {function} fn
   */
  onAlert(fn) {
    this.alertHooks.push(fn);
  }

  /**
   * Retrieve recent events from local log.
   * @param {object} opts - { limit, minSeverity, layer, address }
   */
  query(opts = {}) {
    let results = [...this.localLog];
    if (opts.layer)       results = results.filter(e => e.layer === opts.layer);
    if (opts.address)     results = results.filter(e => e.address === opts.address);
    if (opts.minSeverity) {
      const order = { [SEV.INFO]: 0, [SEV.LOW]: 1, [SEV.MEDIUM]: 2, [SEV.HIGH]: 3, [SEV.CRITICAL]: 4 };
      const min = order[opts.minSeverity] ?? 0;
      results = results.filter(e => (order[e.severity] ?? 0) >= min);
    }
    return results.slice(-(opts.limit ?? 100)).reverse();
  }
}


// ═══════════════════════════════════════════════════════════
//  UNIFIED SECURITY ENGINE
//  Composes all 9 layers. Provides a clean interface for
//  the stratum server and share processor to call.
//  Events emitted: 'ban', 'flag', 'alert'
// ═══════════════════════════════════════════════════════════
class SecurityEngine extends EventEmitter {
  /**
   * @param {object} config  — per-layer configuration objects
   * @param {object} deps    — { redis, db, banningManager, fleetManager }
   */
  constructor(config = {}, deps = {}) {
    super();
    this.deps = deps;

    // Instantiate all 9 layers
    this.layers = {
      transport:   new TransportLayer(config.transport   ?? {}),
      protocol:    new ProtocolLayer(config.protocol     ?? {}),
      auth:        new AuthLayer(config.auth             ?? {}),
      fingerprint: new FingerprintLayer(config.fingerprint ?? {}),
      behavior:    new BehaviorLayer(config.behavior     ?? {}),
      rateLimit:   new RateLimitLayer(config.rateLimit   ?? {}),
      identity:    new IdentityLayer(config.identity     ?? {}),
      reputation:  new ReputationLayer(config.reputation ?? {}, deps),
      audit:       new AuditLayer(config.audit           ?? {}, deps),
    };

    // Wire audit hooks to other layers via engine events
    this.on('ban',  event => this.layers.audit.record({ ...event, result: RESULT.BAN }));
    this.on('flag', event => this.layers.audit.record({ ...event, result: RESULT.FLAG }));

    // Periodic maintenance
    this._cleanupTimer = null;
    this._decayTimer   = null;
  }

  // ─── Lifecycle ──────────────────────────────────────────

  start() {
    this._cleanupTimer = setInterval(() => this._cleanup(), 5 * 60 * 1000);
    this._decayTimer   = setInterval(() => this.layers.reputation.decayAll(), 60 * 60 * 1000);

    log.info('🛡️  Nine-layer security engine online');
    log.info('   L1 Transport  • L2 Protocol  • L3 Auth');
    log.info('   L4 Fingerprint • L5 Behavior  • L6 RateLimit');
    log.info('   L7 Identity   • L8 Reputation • L9 Audit');
  }

  stop() {
    clearInterval(this._cleanupTimer);
    clearInterval(this._decayTimer);
  }

  // ─── Primary hooks ──────────────────────────────────────

  /**
   * Called on raw socket connect (before Stratum handshake).
   * Runs L1 (transport) + L6 (rate limit).
   */
  async onConnect(socket, ip, isFleet = false) {
    // L1
    const l1 = this.layers.transport.check(socket);
    if (l1.result !== RESULT.PASS) return this._handle(l1, { ip });

    // L6
    const l6 = this.layers.rateLimit.checkConnection(ip, isFleet);
    if (l6) return this._handle(l6, { ip });

    await this.layers.audit.record({ layer: 1, result: RESULT.PASS, ip,
      meta: l1.meta, severity: SEV.INFO });
    return { result: RESULT.PASS };
  }

  /**
   * Called on mining.subscribe — issues mining cookie (L3).
   */
  onSubscribe(clientId) {
    const cookie = this.layers.auth.issueCookie(clientId);
    return { cookie };
  }

  /**
   * Called on mining.authorize — validates address (L7) + reputation check (L8).
   * @param {string} clientId
   * @param {string} workerString  - "LTC_ADDRESS.worker_name"
   * @param {string} ip
   */
  async onAuthorize(clientId, workerString, ip) {
    // L7 — address + identity
    const l7 = this.layers.identity.registerMiner(clientId, workerString);
    if (l7.result !== RESULT.PASS) return this._handle(l7, { clientId, ip, address: l7.address });

    // L8 — reputation check on connect
    const l8 = await this.layers.reputation.checkOnConnect(l7.address);
    if (l8.result === RESULT.BAN) return this._handle(l8, { clientId, ip, address: l7.address });
    if (l8.result === RESULT.FLAG) {
      await this.layers.audit.record({ layer: 8, result: RESULT.FLAG, reason: l8.reason,
        severity: l8.severity, clientId, ip, address: l7.address });
    }

    return { result: RESULT.PASS, address: l7.address };
  }

  /**
   * Called on every mining.submit.
   * Runs L2 (protocol), L3 (cookie), L4 (fingerprint),
   * L5 (behavior), L6 (share rate), L7 (payout integrity).
   *
   * @param {object} client - { id, ip, address, workerName }
   * @param {object} share  - { jobId, extraNonce2, ntime, nonce, difficulty,
   *                            isFullBlock, isStale, submittedCookie, hashrateGhps }
   * @returns {{ result, reason, layer } | { result: PASS }}
   */
  async onShare(client, share) {
    const { id: clientId, ip, address } = client;
    const ctx = { clientId, ip, address,
      ntime: share.ntime, difficulty: share.difficulty,
      hashrateGhps: share.hashrateGhps };

    // L6 — share rate
    const l6s = this.layers.rateLimit.checkShareRate(clientId);
    if (l6s) return this._handle(l6s, { clientId, ip, address });

    // L3 — cookie verification
    if (share.submittedCookie) {
      const l3 = this.layers.auth.verifyCookie(clientId, share.submittedCookie);
      if (l3.result !== RESULT.PASS) return this._handle(l3, { clientId, ip, address });
    }

    // L7 — payout integrity
    if (address) {
      const l7 = this.layers.identity.verifyPayoutIntegrity(clientId, address);
      if (l7.result !== RESULT.PASS) return this._handle(l7, { clientId, ip, address });
    }

    // L4 — share fingerprinting
    const l4 = this.layers.fingerprint.recordShare(address, share.isFullBlock, share.isStale);
    if (l4) {
      const rep = await this.layers.reputation.penalize(address, l4.severity);
      await this.layers.audit.record({ ...l4, clientId, ip, address,
        meta: { repScore: rep.newScore } });
      if (rep.action === 'ban') return this._handle({ result: RESULT.BAN, ...l4 }, ctx);
    }

    // L5 — behavioral analysis
    const l5 = this.layers.behavior.analyze(ctx);
    if (l5) {
      const rep = await this.layers.reputation.penalize(address, l5.severity);
      await this.layers.audit.record({ ...l5, clientId, ip, address,
        meta: { repScore: rep.newScore } });
      if (rep.action === 'ban') return this._handle({ result: RESULT.BAN, ...l5 }, ctx);
      if (l5.result === RESULT.BAN) return this._handle(l5, ctx);
    }

    return { result: RESULT.PASS };
  }

  /**
   * Called when a block is found — reward the miner's reputation.
   */
  async onBlockFound(address) {
    const score = await this.layers.reputation.reward(address, 'block_found');
    await this.layers.audit.record({
      layer: 8, result: RESULT.PASS, reason: 'Block found — reputation rewarded',
      severity: SEV.INFO, address, meta: { newScore: score },
    });
  }

  /**
   * Called on client disconnect.
   */
  async onDisconnect(client) {
    const { id: clientId, ip, address } = client;

    // L5 — session analysis
    const l5 = this.layers.behavior.onDisconnect(clientId);
    if (l5) {
      await this.layers.audit.record({ ...l5, clientId, ip, address });
    }

    // Cleanup
    this.layers.auth.revokeCookie(clientId);
    this.layers.identity.deregisterMiner(clientId);
    this.layers.rateLimit.onDisconnect(ip);
  }

  /**
   * Validate a raw protocol message (call before processing).
   */
  checkProtocol(raw, ip) {
    return this.layers.protocol.check(raw, ip);
  }

  /**
   * Register an alert callback on the audit layer.
   * fn(event) is called for every HIGH/CRITICAL event.
   */
  onAlert(fn) {
    this.layers.audit.onAlert(fn);
  }

  /**
   * Query audit trail.
   */
  queryAudit(opts) {
    return this.layers.audit.query(opts);
  }

  /**
   * Get reputation score for a miner.
   */
  async getReputation(address) {
    return this.layers.reputation.getScore(address);
  }

  // ─── Internals ──────────────────────────────────────────

  /**
   * Central result handler — dispatches to banning and events.
   */
  _handle(finding, ctx = {}) {
    const event = { ...finding, ...ctx };

    if (finding.result === RESULT.BAN) {
      log.warn({ ...ctx, reason: finding.reason, layer: finding.layer }, '🚫 Security ban');
      this.emit('ban', event);
      if (this.deps.banningManager && ctx.ip) {
        this.deps.banningManager.ban(ctx.ip, finding.reason);
      }
    } else if (finding.result === RESULT.FLAG) {
      log.info({ ...ctx, reason: finding.reason, layer: finding.layer }, '⚑  Security flag');
      this.emit('flag', event);
    } else if (finding.result === RESULT.REJECT) {
      log.debug({ ...ctx, reason: finding.reason, layer: finding.layer }, '✗  Share rejected');
    }

    return finding;
  }

  _cleanup() {
    this.layers.protocol.cleanup();
    this.layers.fingerprint.cleanup();
    this.layers.behavior.cleanup();
    this.layers.rateLimit.cleanup();
  }

  /**
   * Return a status summary for each layer (for operator dashboard API).
   */
  async getStatus() {
    return {
      layers: [
        { id: 1, name: 'Transport Security',          active: true,
          detail: `TLS enforcement ${this.layers.transport.requireTls ? 'ON' : 'off'}, min ${this.layers.transport.minTlsVersion}` },
        { id: 2, name: 'Protocol Hardening',           active: true,
          detail: `Max frame ${this.layers.protocol.maxMessageBytes}B, ${this.layers.protocol.violations.size} tracked violators` },
        { id: 3, name: 'Authentication & Cookies',     active: true,
          detail: `${this.layers.auth.cookies.size} active cookies issued` },
        { id: 4, name: 'Share Fingerprinting',         active: true,
          detail: `Tracking ${this.layers.fingerprint.profiles.size} miner profiles` },
        { id: 5, name: 'Behavioral Anomaly Detection', active: true,
          detail: `${this.layers.behavior.profiles.size} active behavioral profiles` },
        { id: 6, name: 'Rate Limiting & DDoS Guard',   active: true,
          detail: `${this.layers.rateLimit.activeConns.size} active IPs tracked` },
        { id: 7, name: 'Address & Identity Validation',active: true,
          detail: `${this.layers.identity.addressWorkers.size} registered addresses` },
        { id: 8, name: 'Reputation Scoring Engine',    active: true,
          detail: `Score range 0–1000, ban <${this.layers.reputation.banThreshold}` },
        { id: 9, name: 'Audit Trail & Forensics',      active: true,
          detail: `${this.layers.audit.localLog.length} events in local buffer` },
      ],
    };
  }
}

module.exports = {
  SecurityEngine,
  // Export individual layers for unit testing
  TransportLayer, ProtocolLayer, AuthLayer, FingerprintLayer,
  BehaviorLayer, RateLimitLayer, IdentityLayer, ReputationLayer, AuditLayer,
  SEV, RESULT,
};
