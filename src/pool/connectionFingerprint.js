/**
 * LUXXPOOL v0.7.0 — Connection Fingerprinter
 * Fingerprints TCP/TLS connections to detect:
 *   - Spoofed IPs (same fingerprint from different IPs = VPN/proxy)
 *   - Botnet clusters (many IPs with identical fingerprints)
 *   - Protocol anomalies (unusual connection behavior)
 *
 * Fingerprint components:
 *   - Initial data timing (time to first message after connect)
 *   - Message ordering (subscribe before authorize, etc.)
 *   - Buffer behavior (message sizes, fragmentation)
 *   - TLS properties (if SSL connection)
 */

const { createLogger } = require('../utils/logger');

const log = createLogger('fingerprint');

// Cluster threshold — if N+ IPs share an identical fingerprint hash, flag as suspicious
const CLUSTER_THRESHOLD = 5;

class ConnectionFingerprinter {
  constructor() {
    // fingerprint hash → Set<ip>
    this.clusters = new Map();
    // clientId → fingerprint data
    this.connections = new Map();
    this.timer = null;
  }

  start() {
    // Clean up stale data every 15 minutes
    this.timer = setInterval(() => this._cleanup(), 900000);
    log.info('Connection fingerprinter started');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Start fingerprinting a new connection.
   * Called immediately when a TCP socket connects.
   * @param {string} clientId
   * @param {object} socket - net.Socket or tls.TLSSocket
   * @param {string} ip
   * @returns {object} Initial fingerprint data
   */
  onConnect(clientId, socket, ip) {
    const fp = {
      clientId,
      ip,
      connectedAt: Date.now(),
      firstMessageAt: null,
      messageSequence: [],       // ordered list of Stratum method names
      messageSizes: [],          // sizes of first N messages
      messageCount: 0,
      isSSL: !!socket.encrypted,
      tlsCipher: socket.getCipher ? socket.getCipher()?.name : null,
      tlsProtocol: socket.getProtocol ? socket.getProtocol() : null,
      hash: null,                // computed after enough data
    };

    this.connections.set(clientId, fp);
    return fp;
  }

  /**
   * Record a message received from a connection.
   * @param {string} clientId
   * @param {string} method - Stratum method name
   * @param {number} messageSize - Raw message byte length
   */
  recordMessage(clientId, method, messageSize) {
    const fp = this.connections.get(clientId);
    if (!fp) return;

    if (!fp.firstMessageAt) {
      fp.firstMessageAt = Date.now();
    }

    fp.messageCount++;

    // Track first 10 messages for sequence analysis
    if (fp.messageSequence.length < 10) {
      fp.messageSequence.push(method);
      fp.messageSizes.push(messageSize);
    }

    // Compute fingerprint hash after 3 messages (subscribe + authorize + first share)
    if (fp.messageCount === 3 && !fp.hash) {
      fp.hash = this._computeHash(fp);
      this._registerCluster(fp.hash, fp.ip);
    }
  }

  /**
   * Remove a connection's fingerprint data.
   * @param {string} clientId
   */
  onDisconnect(clientId) {
    const fp = this.connections.get(clientId);
    if (fp && fp.hash) {
      const cluster = this.clusters.get(fp.hash);
      if (cluster) {
        cluster.delete(fp.ip);
        if (cluster.size === 0) this.clusters.delete(fp.hash);
      }
    }
    this.connections.delete(clientId);
  }

  /**
   * Check if a connection exhibits anomalous behavior.
   * @param {string} clientId
   * @returns {{ anomalous: boolean, reasons: string[] }}
   */
  detectAnomaly(clientId) {
    const fp = this.connections.get(clientId);
    if (!fp) return { anomalous: false, reasons: [] };

    const reasons = [];

    // Check 1: Instant first message (< 10ms) — likely scripted/bot
    if (fp.firstMessageAt && (fp.firstMessageAt - fp.connectedAt) < 10) {
      reasons.push('instant_first_message');
    }

    // Check 2: Wrong message order (should be subscribe → authorize)
    if (fp.messageSequence.length >= 2) {
      if (fp.messageSequence[0] !== 'mining.subscribe') {
        reasons.push('wrong_initial_method');
      }
    }

    // Check 3: Message flood before authorization
    if (fp.messageCount > 5 && !fp.messageSequence.includes('mining.authorize')) {
      reasons.push('flood_before_auth');
    }

    // Check 4: Cluster detection (many IPs with same fingerprint)
    if (fp.hash) {
      const cluster = this.clusters.get(fp.hash);
      if (cluster && cluster.size >= CLUSTER_THRESHOLD) {
        reasons.push('botnet_cluster');
      }
    }

    return {
      anomalous: reasons.length > 0,
      reasons,
      clusterSize: fp.hash ? (this.clusters.get(fp.hash)?.size || 0) : 0,
    };
  }

  /**
   * Get cluster analysis — groups of IPs with identical fingerprints.
   * @returns {Array<{ hash, ips, size }>} Clusters with 2+ members
   */
  getClusterReport() {
    const result = [];
    for (const [hash, ips] of this.clusters) {
      if (ips.size >= 2) {
        result.push({
          hash: hash.substring(0, 12),
          ips: Array.from(ips),
          size: ips.size,
          suspicious: ips.size >= CLUSTER_THRESHOLD,
        });
      }
    }
    return result.sort((a, b) => b.size - a.size);
  }

  /**
   * Get fingerprint profile for a specific client.
   * @param {string} clientId
   * @returns {object|null}
   */
  getProfile(clientId) {
    const fp = this.connections.get(clientId);
    if (!fp) return null;

    return {
      ip: fp.ip,
      isSSL: fp.isSSL,
      tlsCipher: fp.tlsCipher,
      tlsProtocol: fp.tlsProtocol,
      timeToFirstMessage: fp.firstMessageAt ? fp.firstMessageAt - fp.connectedAt : null,
      messageSequence: fp.messageSequence,
      messageCount: fp.messageCount,
      fingerprintHash: fp.hash ? fp.hash.substring(0, 12) : null,
      clusterSize: fp.hash ? (this.clusters.get(fp.hash)?.size || 0) : 0,
    };
  }

  // ═══════════════════════════════════════════════════════
  // INTERNAL
  // ═══════════════════════════════════════════════════════

  /**
   * Compute a fingerprint hash from connection behavior.
   * Intentionally coarse-grained to group similar connections.
   */
  _computeHash(fp) {
    const components = [
      fp.isSSL ? 'ssl' : 'tcp',
      fp.tlsCipher || 'none',
      // Bucket time-to-first-message: <50ms, <200ms, <1000ms, >1000ms
      fp.firstMessageAt ? this._bucketTime(fp.firstMessageAt - fp.connectedAt) : 'none',
      // Message sequence
      fp.messageSequence.slice(0, 3).join(','),
      // Average message size bucket
      this._bucketSize(fp.messageSizes),
    ];

    // Simple hash — not cryptographic, just for grouping
    let hash = 0;
    const str = components.join('|');
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  _bucketTime(ms) {
    if (ms < 50) return 'instant';
    if (ms < 200) return 'fast';
    if (ms < 1000) return 'normal';
    return 'slow';
  }

  _bucketSize(sizes) {
    if (sizes.length === 0) return 'none';
    const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    if (avg < 100) return 'small';
    if (avg < 300) return 'medium';
    return 'large';
  }

  _registerCluster(hash, ip) {
    if (!this.clusters.has(hash)) {
      this.clusters.set(hash, new Set());
    }
    this.clusters.get(hash).add(ip);

    const size = this.clusters.get(hash).size;
    if (size === CLUSTER_THRESHOLD) {
      log.warn({ hash: hash.substring(0, 12), size }, 'Suspicious connection cluster detected');
    }
  }

  _cleanup() {
    const staleThreshold = Date.now() - 3600000; // 1 hour
    for (const [clientId, fp] of this.connections) {
      if (fp.connectedAt < staleThreshold && fp.messageCount === 0) {
        this.connections.delete(clientId);
      }
    }
  }
}

module.exports = ConnectionFingerprinter;
