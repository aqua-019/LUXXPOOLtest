/**
 * LUXXPOOL v0.7.0 — Miner Registry
 * Identifies mining hardware models from Stratum user-agent strings.
 * Provides optimal difficulty profiles and firmware version tracking.
 *
 * Scrypt ASIC miners send a user-agent during mining.subscribe.
 * Common formats:
 *   bmminer/4.11.1        (Bitmain Antminer L-series)
 *   cgminer/4.12.1        (Generic, many ASICs)
 *   ElphaPex/2.0.3        (ElphaPex DG-series)
 *   VOLCMINER/1.0.0       (VOLCMINER D-series)
 *   GoldshellMiner/1.0    (Goldshell LT-series)
 */

const { createLogger } = require('../utils/logger');

const log = createLogger('miner-registry');

// ═══════════════════════════════════════════════════════════
// KNOWN MINER PROFILES
// ═══════════════════════════════════════════════════════════

const MINER_PROFILES = {
  'antminer-l9': {
    name: 'Antminer L9',
    manufacturer: 'Bitmain',
    algorithm: 'scrypt',
    expectedHashrate: 16e12,    // 16 TH/s
    optimalDiff: 65536,
    power: 3260,                // watts
    latestFirmware: { version: '4.11.1', date: '2025-06-01', urgency: 'recommended' },
  },
  'antminer-l7': {
    name: 'Antminer L7',
    manufacturer: 'Bitmain',
    algorithm: 'scrypt',
    expectedHashrate: 9.5e12,   // 9.5 TH/s
    optimalDiff: 32768,
    power: 3425,
    latestFirmware: { version: '4.11.1', date: '2025-06-01', urgency: 'recommended' },
  },
  'antminer-l3+': {
    name: 'Antminer L3+',
    manufacturer: 'Bitmain',
    algorithm: 'scrypt',
    expectedHashrate: 504e6,    // 504 MH/s
    optimalDiff: 2048,
    power: 800,
    latestFirmware: { version: '4.9.2', date: '2023-01-15', urgency: 'optional' },
  },
  'elphapex-dg2': {
    name: 'ElphaPex DG2',
    manufacturer: 'ElphaPex',
    algorithm: 'scrypt',
    expectedHashrate: 36e12,    // 36 TH/s
    optimalDiff: 65536,
    power: 4000,
    latestFirmware: { version: '2.1.0', date: '2025-09-01', urgency: 'recommended' },
  },
  'elphapex-dg1': {
    name: 'ElphaPex DG1',
    manufacturer: 'ElphaPex',
    algorithm: 'scrypt',
    expectedHashrate: 14e12,    // 14 TH/s
    optimalDiff: 65536,
    power: 3920,
    latestFirmware: { version: '2.1.0', date: '2025-09-01', urgency: 'recommended' },
  },
  'volcminer-d1': {
    name: 'VOLCMINER D1',
    manufacturer: 'VOLCMINER',
    algorithm: 'scrypt',
    expectedHashrate: 11e12,    // 11 TH/s
    optimalDiff: 32768,
    power: 3400,
    latestFirmware: { version: '1.2.0', date: '2025-07-01', urgency: 'recommended' },
  },
  'goldshell-lt6': {
    name: 'Goldshell LT6',
    manufacturer: 'Goldshell',
    algorithm: 'scrypt',
    expectedHashrate: 3.35e12,  // 3.35 TH/s
    optimalDiff: 8192,
    power: 3200,
    latestFirmware: { version: '1.3.0', date: '2025-03-01', urgency: 'optional' },
  },
  'goldshell-lt5-pro': {
    name: 'Goldshell LT5 Pro',
    manufacturer: 'Goldshell',
    algorithm: 'scrypt',
    expectedHashrate: 2.45e12,  // 2.45 TH/s
    optimalDiff: 4096,
    power: 3100,
    latestFirmware: { version: '1.3.0', date: '2025-03-01', urgency: 'optional' },
  },
};

// ═══════════════════════════════════════════════════════════
// USER-AGENT PARSING PATTERNS
// ═══════════════════════════════════════════════════════════

const UA_PATTERNS = [
  // Bitmain Antminer (bmminer)
  {
    regex: /bmminer\/([\d.]+)/i,
    detectModel: (match, fullUA) => {
      // bmminer doesn't include model in UA — infer from hashrate later
      // Default to generic antminer detection
      return { software: 'bmminer', firmware: match[1], modelHint: 'antminer' };
    },
  },
  // cgminer (used by many manufacturers)
  {
    regex: /cgminer\/([\d.]+)/i,
    detectModel: (match, fullUA) => {
      return { software: 'cgminer', firmware: match[1], modelHint: 'generic' };
    },
  },
  // ElphaPex
  {
    regex: /ElphaPex\/([\d.]+)/i,
    detectModel: (match, fullUA) => {
      // Check for DG2 vs DG1 — DG2 has higher hashrate, but we detect from UA if available
      const model = /DG2/i.test(fullUA) ? 'elphapex-dg2' : 'elphapex-dg1';
      return { software: 'ElphaPex', firmware: match[1], modelKey: model };
    },
  },
  // VOLCMINER
  {
    regex: /VOLCMINER\/([\d.]+)/i,
    detectModel: (match, fullUA) => {
      return { software: 'VOLCMINER', firmware: match[1], modelKey: 'volcminer-d1' };
    },
  },
  // Goldshell
  {
    regex: /GoldshellMiner\/([\d.]+)/i,
    detectModel: (match, fullUA) => {
      const model = /LT6/i.test(fullUA) ? 'goldshell-lt6' : 'goldshell-lt5-pro';
      return { software: 'GoldshellMiner', firmware: match[1], modelKey: model };
    },
  },
  // BFGMiner
  {
    regex: /bfgminer\/([\d.]+)/i,
    detectModel: (match) => {
      return { software: 'bfgminer', firmware: match[1], modelHint: 'generic' };
    },
  },
];

// ═══════════════════════════════════════════════════════════
// MINER REGISTRY CLASS
// ═══════════════════════════════════════════════════════════

class MinerRegistry {
  constructor() {
    this.profiles = MINER_PROFILES;
    this.patterns = UA_PATTERNS;
  }

  /**
   * Parse a Stratum user-agent string into model/firmware info.
   * @param {string} userAgent - Raw user-agent from mining.subscribe
   * @returns {{ modelKey: string|null, model: string|null, firmware: string|null, software: string|null, profile: object|null }}
   */
  parseUserAgent(userAgent) {
    if (!userAgent || typeof userAgent !== 'string') {
      return { modelKey: null, model: null, firmware: null, software: null, profile: null };
    }

    for (const pattern of this.patterns) {
      const match = userAgent.match(pattern.regex);
      if (match) {
        const detected = pattern.detectModel(match, userAgent);
        const modelKey = detected.modelKey || null;
        const profile = modelKey ? this.profiles[modelKey] : null;

        return {
          modelKey,
          model: profile ? profile.name : (detected.modelHint || 'unknown'),
          firmware: detected.firmware || null,
          software: detected.software || null,
          profile,
        };
      }
    }

    // Unknown miner
    return { modelKey: null, model: 'unknown', firmware: null, software: userAgent, profile: null };
  }

  /**
   * Refine model detection using observed hashrate.
   * Called after enough shares to estimate hashrate (~5 minutes).
   * @param {string} currentModelKey
   * @param {number} observedHashrate - Actual hashrate in H/s
   * @returns {string|null} Refined model key, or null if unchanged
   */
  refineModelByHashrate(currentModelKey, observedHashrate) {
    if (currentModelKey && currentModelKey !== 'generic') return null;
    if (!observedHashrate || observedHashrate <= 0) return null;

    let bestMatch = null;
    let bestDelta = Infinity;

    for (const [key, profile] of Object.entries(this.profiles)) {
      const delta = Math.abs(observedHashrate - profile.expectedHashrate) / profile.expectedHashrate;
      if (delta < bestDelta && delta < 0.3) { // Within 30% tolerance
        bestDelta = delta;
        bestMatch = key;
      }
    }

    return bestMatch;
  }

  /**
   * Get the profile for a known miner model.
   * @param {string} modelKey
   * @returns {object|null}
   */
  getProfile(modelKey) {
    return this.profiles[modelKey] || null;
  }

  /**
   * Get optimal initial difficulty for a miner model.
   * Falls back to default if model unknown.
   * @param {string} modelKey
   * @param {number} defaultDiff
   * @returns {number}
   */
  getOptimalDifficulty(modelKey, defaultDiff = 512) {
    const profile = this.profiles[modelKey];
    return profile ? profile.optimalDiff : defaultDiff;
  }

  /**
   * Get expected hashrate for a miner model.
   * @param {string} modelKey
   * @returns {number} Expected hashrate in H/s, or 0 if unknown
   */
  getExpectedHashrate(modelKey) {
    const profile = this.profiles[modelKey];
    return profile ? profile.expectedHashrate : 0;
  }

  /**
   * Check if a firmware version is outdated for a given model.
   * @param {string} modelKey
   * @param {string} currentVersion
   * @returns {boolean}
   */
  isOutdatedFirmware(modelKey, currentVersion) {
    const profile = this.profiles[modelKey];
    if (!profile || !profile.latestFirmware || !currentVersion) return false;
    return this._compareVersions(currentVersion, profile.latestFirmware.version) < 0;
  }

  /**
   * Get firmware update recommendation for a miner.
   * @param {string} modelKey
   * @param {string} currentVersion
   * @returns {{ available: boolean, version: string|null, urgency: string|null }}
   */
  getUpdateRecommendation(modelKey, currentVersion) {
    const profile = this.profiles[modelKey];
    if (!profile || !profile.latestFirmware) {
      return { available: false, version: null, urgency: null };
    }

    if (!currentVersion || this._compareVersions(currentVersion, profile.latestFirmware.version) < 0) {
      return {
        available: true,
        version: profile.latestFirmware.version,
        urgency: profile.latestFirmware.urgency,
      };
    }

    return { available: false, version: null, urgency: null };
  }

  /**
   * Get all known miner profiles.
   * @returns {object}
   */
  getAllProfiles() {
    return { ...this.profiles };
  }

  /**
   * Simple semver comparison: -1 if a < b, 0 if equal, 1 if a > b.
   */
  _compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    const len = Math.max(pa.length, pb.length);

    for (let i = 0; i < len; i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na < nb) return -1;
      if (na > nb) return 1;
    }
    return 0;
  }
}

module.exports = MinerRegistry;
