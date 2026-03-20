/**
 * LUXXPOOL v0.7.0 — Miner Registry
 * ═══════════════════════════════════════════════════════════
 * Identifies Scrypt ASIC models from Stratum user-agent strings.
 * Provides model-aware optimal difficulty, expected hashrate,
 * and known firmware version data for each supported model.
 *
 * Supported Models:
 *   Antminer L9  (340 GH/s) — Bitmain flagship Scrypt ASIC
 *   Antminer L7  (9.5 GH/s) — Previous generation
 *   Antminer L3+ (504 MH/s) — Legacy, still widely deployed
 *   ElphaPex DG2 (36 GH/s)  — Newer competitor
 *   ElphaPex DG1 (14 GH/s)  — Entry-level ElphaPex
 *   VOLCMINER D1 (5 GH/s)   — Budget ASIC
 *   Goldshell LT6 (3.35 GH/s) — Goldshell flagship
 *   Goldshell LT5 Pro (2.45 GH/s) — Mid-range Goldshell
 *
 * Security Context:
 *   - ASIC firmware compromise is a high-probability threat
 *   - L9 runs Angstrom Linux with known vulnerabilities:
 *     unsigned firmware upgrades, default SSH (root/root), CGI as root
 *   - User-agent can be spoofed; use as advisory, not for security decisions
 */

const { createLogger } = require('../utils/logger');

const log = createLogger('miner-registry');

/**
 * ASIC model database
 * Each entry contains hardware specs, optimal pool settings,
 * and known firmware versions for update advisories.
 */
const MODELS = {
  'antminer-l9': {
    name: 'Antminer L9',
    manufacturer: 'Bitmain',
    expectedHashrate: 340e9,      // 340 GH/s
    optimalDifficulty: 65536,
    power: 3260,                   // watts
    algorithm: 'scrypt',
    // User-agent patterns (case-insensitive)
    patterns: [
      /antminer\s*l9/i,
      /bitmain.*l9/i,
      /cgminer.*l9/i,
    ],
    firmware: {
      current: '2025.11.1',
      supported: ['2025.11.1', '2025.08.2', '2025.05.1', '2024.12.1'],
      critical: ['2024.06.0'],  // known vulnerable versions
    },
  },
  'antminer-l7': {
    name: 'Antminer L7',
    manufacturer: 'Bitmain',
    expectedHashrate: 9.5e9,       // 9.5 GH/s
    optimalDifficulty: 8192,
    power: 3425,
    algorithm: 'scrypt',
    patterns: [
      /antminer\s*l7/i,
      /bitmain.*l7/i,
      /cgminer.*l7/i,
    ],
    firmware: {
      current: '2024.08.1',
      supported: ['2024.08.1', '2024.03.1', '2023.10.1'],
      critical: [],
    },
  },
  'antminer-l3plus': {
    name: 'Antminer L3+',
    manufacturer: 'Bitmain',
    expectedHashrate: 504e6,       // 504 MH/s
    optimalDifficulty: 512,
    power: 800,
    algorithm: 'scrypt',
    patterns: [
      /antminer\s*l3\+/i,
      /antminer\s*l3plus/i,
      /bitmain.*l3/i,
      /cgminer.*l3/i,
    ],
    firmware: {
      current: '2019.12.1',
      supported: ['2019.12.1', '2019.06.1'],
      critical: ['2017.11.0'],
    },
  },
  'elphapex-dg2': {
    name: 'ElphaPex DG2',
    manufacturer: 'ElphaPex',
    expectedHashrate: 36e9,        // 36 GH/s
    optimalDifficulty: 16384,
    power: 2800,
    algorithm: 'scrypt',
    patterns: [
      /elphapex.*dg2/i,
      /dg2/i,
    ],
    firmware: {
      current: '1.4.0',
      supported: ['1.4.0', '1.3.0', '1.2.0'],
      critical: [],
    },
  },
  'elphapex-dg1': {
    name: 'ElphaPex DG1',
    manufacturer: 'ElphaPex',
    expectedHashrate: 14e9,        // 14 GH/s
    optimalDifficulty: 4096,
    power: 2000,
    algorithm: 'scrypt',
    patterns: [
      /elphapex.*dg1/i,
      /dg1[^0-9]/i,
    ],
    firmware: {
      current: '1.3.0',
      supported: ['1.3.0', '1.2.0'],
      critical: [],
    },
  },
  'volcminer-d1': {
    name: 'VOLCMINER D1',
    manufacturer: 'VOLCMINER',
    expectedHashrate: 5e9,         // 5 GH/s
    optimalDifficulty: 2048,
    power: 1200,
    algorithm: 'scrypt',
    patterns: [
      /volcminer.*d1/i,
      /volc.*d1/i,
    ],
    firmware: {
      current: '2.1.0',
      supported: ['2.1.0', '2.0.0'],
      critical: [],
    },
  },
  'goldshell-lt6': {
    name: 'Goldshell LT6',
    manufacturer: 'Goldshell',
    expectedHashrate: 3.35e9,      // 3.35 GH/s
    optimalDifficulty: 1024,
    power: 3200,
    algorithm: 'scrypt',
    patterns: [
      /goldshell.*lt6/i,
      /lt6/i,
    ],
    firmware: {
      current: '2.2.1',
      supported: ['2.2.1', '2.1.0'],
      critical: [],
    },
  },
  'goldshell-lt5pro': {
    name: 'Goldshell LT5 Pro',
    manufacturer: 'Goldshell',
    expectedHashrate: 2.45e9,      // 2.45 GH/s
    optimalDifficulty: 1024,
    power: 3100,
    algorithm: 'scrypt',
    patterns: [
      /goldshell.*lt5\s*pro/i,
      /lt5\s*pro/i,
      /lt5pro/i,
    ],
    firmware: {
      current: '2.2.1',
      supported: ['2.2.1', '2.1.0'],
      critical: [],
    },
  },
};

class MinerRegistry {
  constructor() {
    this.models = MODELS;
    this.detectionCache = new Map(); // userAgent → model key (LRU-ish)
  }

  /**
   * Identify miner model from user-agent string.
   * User-agents vary by firmware: cgminer, bmminer, cpuminer, custom.
   * Examples:
   *   "cgminer/4.11.1 L9"
   *   "bmminer/2.0.0 Antminer L7"
   *   "ElphaPex DG2 v1.4.0"
   *
   * @param {string} userAgent - Raw user-agent from mining.subscribe
   * @returns {object|null} Model profile or null if unrecognized
   */
  identify(userAgent) {
    if (!userAgent || typeof userAgent !== 'string') return null;

    // Check cache first
    if (this.detectionCache.has(userAgent)) {
      const key = this.detectionCache.get(userAgent);
      return key ? { key, ...this.models[key] } : null;
    }

    // Try each model's patterns
    for (const [key, model] of Object.entries(this.models)) {
      for (const pattern of model.patterns) {
        if (pattern.test(userAgent)) {
          this.detectionCache.set(userAgent, key);

          // Cap cache size
          if (this.detectionCache.size > 1000) {
            const firstKey = this.detectionCache.keys().next().value;
            this.detectionCache.delete(firstKey);
          }

          log.info({ model: model.name, userAgent }, 'Miner model identified');
          return { key, ...model };
        }
      }
    }

    // Unknown model
    this.detectionCache.set(userAgent, null);
    log.debug({ userAgent }, 'Unknown miner model');
    return null;
  }

  /**
   * Extract firmware version from user-agent string.
   * Common patterns:
   *   "cgminer/4.11.1" → "4.11.1"
   *   "bmminer/2.0.0"  → "2.0.0"
   *   "v1.4.0"         → "1.4.0"
   */
  extractFirmwareVersion(userAgent) {
    if (!userAgent) return null;

    // Try common version patterns
    const patterns = [
      /(?:cgminer|bmminer|cpuminer|sgminer)[\/\s](\d+\.\d+\.\d+)/i,
      /v(\d+\.\d+\.\d+)/i,
      /(\d{4}\.\d{1,2}\.\d+)/,  // date-based versions like 2025.11.1
      /(\d+\.\d+\.\d+)/,        // generic semver
    ];

    for (const pattern of patterns) {
      const match = userAgent.match(pattern);
      if (match) return match[1];
    }

    return null;
  }

  /**
   * Check if a firmware version is outdated for a given model.
   * @returns {{ outdated: boolean, critical: boolean, current: string }}
   */
  checkFirmwareStatus(modelKey, version) {
    const model = this.models[modelKey];
    if (!model || !version) return { outdated: false, critical: false, current: null };

    const isCritical = model.firmware.critical.includes(version);
    const isSupported = model.firmware.supported.includes(version);
    const isCurrent = version === model.firmware.current;

    return {
      outdated: !isCurrent,
      critical: isCritical,
      current: model.firmware.current,
      supported: isSupported,
    };
  }

  /**
   * Get optimal starting difficulty for a model.
   * Reduces VarDiff convergence from ~5 retargets to ~1.
   */
  getOptimalDifficulty(modelKey) {
    const model = this.models[modelKey];
    return model ? model.optimalDifficulty : null;
  }

  /**
   * Get expected hashrate for efficiency comparison.
   */
  getExpectedHashrate(modelKey) {
    const model = this.models[modelKey];
    return model ? model.expectedHashrate : null;
  }

  /**
   * Get all registered models for dashboard display.
   */
  getAllModels() {
    return Object.entries(this.models).map(([key, model]) => ({
      key,
      name: model.name,
      manufacturer: model.manufacturer,
      expectedHashrate: model.expectedHashrate,
      optimalDifficulty: model.optimalDifficulty,
      power: model.power,
      currentFirmware: model.firmware.current,
    }));
  }

  /**
   * Get model-aware minimum difficulty floor.
   * Prevents VarDiff gaming: L9 cannot go below 8192.
   * Addresses documented 6.5M shares/sec exploit at diff=0.001.
   */
  getDifficultyFloor(modelKey) {
    const model = this.models[modelKey];
    if (!model) return 64; // default minimum

    // Floor = optimal / 8 (allows some headroom but prevents gaming)
    return Math.max(64, Math.floor(model.optimalDifficulty / 8));
  }
}

module.exports = MinerRegistry;
