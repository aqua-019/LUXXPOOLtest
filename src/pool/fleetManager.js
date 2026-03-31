/**
 * LUXXPOOL v0.5.1 — Fleet Management
 * ═══════════════════════════════════════════════════════════
 * Distinguishes LUXX-owned miners from public miners.
 *
 * Fleet miners (LUXX-owned):
 *   - Whitelisted IPs: exempt from per-IP connection limits
 *   - Exempt from banning (firmware glitch won't lock out fleet)
 *   - Exempt from Sybil detection (20 miners, 1 facility = normal)
 *   - Zero pool fee (you don't charge yourself)
 *   - Priority connection slots (reserved capacity)
 *   - Dedicated fleet health monitoring
 *
 * Public miners:
 *   - Standard per-IP limits (5 connections)
 *   - Standard banning rules
 *   - Standard pool fee (2%)
 *   - Security engine active (all 3 layers)
 *
 * Configuration via .env:
 *   FLEET_IPS=192.168.1.0/24,10.0.0.0/8,203.0.113.50
 *   FLEET_ADDRESSES=LhXk7...,Ltc1q...,M3abc...
 *   FLEET_FEE=0
 *   FLEET_MAX_MINERS=100
 */

const { createLogger } = require('../utils/logger');
const log = createLogger('fleet');

class FleetManager {
  /**
   * @param {object} config
   * @param {string[]} config.ips - Whitelisted IPs/CIDRs
   * @param {string[]} config.addresses - Whitelisted LTC addresses
   * @param {number} config.fee - Fee for fleet miners (default 0)
   * @param {number} config.maxMiners - Max fleet miner slots (default 100)
   */
  constructor(config = {}) {
    this.whitelistedIps = new Set();
    this.whitelistedCidrs = [];
    this.whitelistedAddresses = new Set();
    this.fleetFee = config.fee ?? 0;
    this.maxFleetMiners = config.maxMiners || 100;

    // Parse IPs and CIDRs
    const ips = config.ips || [];
    for (const entry of ips) {
      if (entry.includes('/')) {
        this.whitelistedCidrs.push(this._parseCidr(entry));
      } else {
        this.whitelistedIps.add(this._normalizeIp(entry));
      }
    }

    // Parse addresses
    const addresses = config.addresses || [];
    for (const addr of addresses) {
      if (addr.trim()) this.whitelistedAddresses.add(addr.trim());
    }

    // Fleet miner tracking
    this.fleetMiners = new Map();  // clientId → { worker, ip, connectedAt, hashrate, shares }
    this.publicMiners = new Map();

    log.info({
      whitelistedIps: this.whitelistedIps.size,
      whitelistedCidrs: this.whitelistedCidrs.length,
      whitelistedAddresses: this.whitelistedAddresses.size,
      fleetFee: this.fleetFee,
      maxFleetMiners: this.maxFleetMiners,
    }, 'Fleet manager initialized');
  }

  // ═══════════════════════════════════════════════════════
  // CLASSIFICATION
  // ═══════════════════════════════════════════════════════

  /**
   * Check if an IP belongs to the fleet
   * @param {string} ip
   * @returns {boolean}
   */
  isFleetIp(ip) {
    const normalized = this._normalizeIp(ip);

    // Direct IP match
    if (this.whitelistedIps.has(normalized)) return true;

    // CIDR match
    for (const cidr of this.whitelistedCidrs) {
      if (this._ipInCidr(normalized, cidr)) return true;
    }

    return false;
  }

  /**
   * Check if a mining address belongs to the fleet
   * @param {string} address
   * @returns {boolean}
   */
  isFleetAddress(address) {
    return this.whitelistedAddresses.has(address);
  }

  /**
   * Classify a connected miner as fleet or public
   * @param {string} ip
   * @param {string} address - Miner's LTC address (may be null if not yet authorized)
   * @returns {'fleet'|'public'}
   */
  classify(ip, address) {
    if (this.isFleetIp(ip)) return 'fleet';
    if (address && this.isFleetAddress(address)) return 'fleet';
    return 'public';
  }

  /**
   * Get the fee for a miner based on classification
   * @param {string} ip
   * @param {string} address
   * @returns {number} Fee as decimal (0 = no fee, 0.02 = 2%)
   */
  getFee(ip, address) {
    return this.classify(ip, address) === 'fleet' ? this.fleetFee : null;
    // null = use default pool fee
  }

  // ═══════════════════════════════════════════════════════
  // TRACKING
  // ═══════════════════════════════════════════════════════

  /**
   * Register a miner connection
   */
  registerMiner(client) {
    const type = this.classify(client.remoteAddress, client.minerAddress);
    const entry = {
      clientId: client.id,
      worker: client.workerName,
      address: client.minerAddress,
      ip: client.remoteAddress,
      type,
      connectedAt: Date.now(),
      hashrate: 0,
      validShares: 0,
    };

    if (type === 'fleet') {
      // Enforce capacity
      if (this.fleetMiners.size >= this.maxFleetMiners) {
        log.warn({ worker: client.workerName, current: this.fleetMiners.size, max: this.maxFleetMiners },
          'Fleet capacity reached — miner classified as public');
        this.publicMiners.set(client.id, { ...entry, type: 'public' });
        client._isFleet = false;
        return;
      }

      this.fleetMiners.set(client.id, entry);
      client._isFleet = true;
      log.info({ worker: client.workerName, ip: client.remoteAddress, fleetSize: this.fleetMiners.size },
        '⛏  Fleet miner connected');
    } else {
      this.publicMiners.set(client.id, entry);
      client._isFleet = false;
    }
  }

  // ═══════════════════════════════════════════════════════
  // RUNTIME FLEET MANAGEMENT (no restart needed)
  // Add new L9 installations, IPs, addresses at runtime
  // ═══════════════════════════════════════════════════════

  /**
   * Add an IP or CIDR to the fleet whitelist at runtime.
   * New miners from this IP will be classified as fleet immediately.
   * @param {string} ipOrCidr - e.g., '203.0.113.50' or '10.0.0.0/24'
   * @returns {boolean} success
   */
  addIp(ipOrCidr) {
    if (!ipOrCidr || typeof ipOrCidr !== 'string') return false;
    const trimmed = ipOrCidr.trim();

    if (trimmed.includes('/')) {
      const cidr = this._parseCidr(trimmed);
      // Avoid duplicates
      const exists = this.whitelistedCidrs.some(c => c.network === cidr.network && c.mask === cidr.mask);
      if (!exists) {
        this.whitelistedCidrs.push(cidr);
        log.info({ cidr: trimmed }, 'Fleet CIDR added at runtime');
      }
    } else {
      this.whitelistedIps.add(this._normalizeIp(trimmed));
      log.info({ ip: trimmed }, 'Fleet IP added at runtime');
    }

    // Reclassify any currently-connected public miners from this IP
    this._reclassifyConnectedMiners();
    return true;
  }

  /**
   * Remove an IP from the fleet whitelist
   * @param {string} ip
   * @returns {boolean}
   */
  removeIp(ip) {
    const normalized = this._normalizeIp(ip);
    const deleted = this.whitelistedIps.delete(normalized);
    if (deleted) log.info({ ip }, 'Fleet IP removed');
    return deleted;
  }

  /**
   * Add a LTC address to the fleet whitelist at runtime.
   * @param {string} address
   * @returns {boolean}
   */
  addAddress(address) {
    if (!address || typeof address !== 'string') return false;
    const trimmed = address.trim();
    this.whitelistedAddresses.add(trimmed);
    log.info({ address: trimmed }, 'Fleet address added at runtime');
    this._reclassifyConnectedMiners();
    return true;
  }

  /**
   * Remove an address from the fleet whitelist
   * @param {string} address
   * @returns {boolean}
   */
  removeAddress(address) {
    const deleted = this.whitelistedAddresses.delete(address);
    if (deleted) log.info({ address }, 'Fleet address removed');
    return deleted;
  }

  /**
   * Update fleet capacity (e.g., scaling from 20 → 50 miners)
   * @param {number} newMax
   */
  setMaxMiners(newMax) {
    this.maxFleetMiners = newMax;
    log.info({ maxMiners: newMax }, 'Fleet capacity updated');
  }

  /**
   * Reclassify connected public miners that now match fleet criteria.
   * Called after addIp/addAddress to upgrade already-connected miners.
   */
  _reclassifyConnectedMiners() {
    let reclassified = 0;
    for (const [id, miner] of this.publicMiners) {
      const newType = this.classify(miner.ip, miner.address);
      if (newType === 'fleet' && this.fleetMiners.size < this.maxFleetMiners) {
        this.publicMiners.delete(id);
        this.fleetMiners.set(id, { ...miner, type: 'fleet' });
        reclassified++;
      }
    }
    if (reclassified > 0) {
      log.info({ count: reclassified }, 'Public miners reclassified as fleet');
    }
  }

  /**
   * Get full fleet configuration (for backup/export)
   */
  getConfig() {
    return {
      ips: [...this.whitelistedIps],
      cidrs: this.whitelistedCidrs.map(c => {
        // Reconstruct CIDR string from network + mask
        const bits = 32 - Math.log2((~c.mask >>> 0) + 1);
        const a = (c.network >>> 24) & 0xff;
        const b = (c.network >>> 16) & 0xff;
        const d = (c.network >>> 8) & 0xff;
        const e = c.network & 0xff;
        return `${a}.${b}.${d}.${e}/${bits}`;
      }),
      addresses: [...this.whitelistedAddresses],
      fee: this.fleetFee,
      maxMiners: this.maxFleetMiners,
    };
  }

  /**
   * Update miner stats
   */
  updateMiner(clientId, updates) {
    const fleet = this.fleetMiners.get(clientId);
    if (fleet) {
      Object.assign(fleet, updates);
      return;
    }
    const pub = this.publicMiners.get(clientId);
    if (pub) Object.assign(pub, updates);
  }

  /**
   * Remove a disconnected miner
   */
  removeMiner(clientId) {
    this.fleetMiners.delete(clientId);
    this.publicMiners.delete(clientId);
  }

  // ═══════════════════════════════════════════════════════
  // FLEET STATS
  // ═══════════════════════════════════════════════════════

  getFleetStats() {
    let totalHashrate = 0;
    let totalShares = 0;
    const miners = [];

    for (const [, m] of this.fleetMiners) {
      totalHashrate += m.hashrate || 0;
      totalShares += m.validShares || 0;
      miners.push({
        worker: m.worker,
        ip: m.ip,
        hashrate: m.hashrate,
        shares: m.validShares,
        uptime: Date.now() - m.connectedAt,
      });
    }

    return {
      count: this.fleetMiners.size,
      maxCapacity: this.maxFleetMiners,
      totalHashrate,
      totalShares,
      fee: this.fleetFee,
      miners,
    };
  }

  getPublicStats() {
    let totalHashrate = 0;
    for (const [, m] of this.publicMiners) {
      totalHashrate += m.hashrate || 0;
    }

    return {
      count: this.publicMiners.size,
      totalHashrate,
    };
  }

  getOverview() {
    const fleet = this.getFleetStats();
    const pub = this.getPublicStats();
    return {
      fleet,
      public: pub,
      totalMiners: fleet.count + pub.count,
      totalHashrate: fleet.totalHashrate + pub.totalHashrate,
      fleetPercentage: fleet.count + pub.count > 0
        ? ((fleet.totalHashrate / (fleet.totalHashrate + pub.totalHashrate)) * 100).toFixed(1) + '%'
        : '0%',
    };
  }

  // ═══════════════════════════════════════════════════════
  // NETWORK UTILITIES
  // ═══════════════════════════════════════════════════════

  _normalizeIp(ip) {
    if (!ip) return '';
    return ip.replace(/^::ffff:/, '');
  }

  _parseCidr(cidr) {
    const [ip, bitsStr] = cidr.split('/');
    if (!bitsStr) throw new Error(`Invalid CIDR: missing /bits — ${cidr}`);
    const bits = parseInt(bitsStr);
    if (isNaN(bits) || bits < 0 || bits > 32) throw new Error(`Invalid CIDR bits: ${bitsStr} (must be 0–32)`);
    const ipNum = this._ipToInt(ip);
    const maskNum = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return { network: (ipNum & maskNum) >>> 0, mask: maskNum };
  }

  _ipInCidr(ip, cidr) {
    const ipNum = this._ipToInt(ip);
    return ((ipNum & cidr.mask) >>> 0) === cidr.network;
  }

  _ipToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return 0;
    return ((parseInt(parts[0]) << 24) |
            (parseInt(parts[1]) << 16) |
            (parseInt(parts[2]) << 8) |
            parseInt(parts[3])) >>> 0;
  }
}

module.exports = FleetManager;
