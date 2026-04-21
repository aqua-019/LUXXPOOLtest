'use strict';

/**
 * LUXXPOOL v0.8.2 — Miner Registry
 * ═══════════════════════════════════════════════════════════
 * Identifies Scrypt ASIC models from Stratum user-agent strings.
 * Provides model-aware optimal difficulty, expected hashrate,
 * and known firmware version data for each supported model.
 *
 * v0.8.2 EXPANSION: 8 profiles → 20 profiles
 * Added: L7 Pro, L11, L11 Pro, L11 Hydro, U2L9H,
 *        DG1+, DG2+, DG Hydro 1, DG Home 1,
 *        VolcMiner D1 Hydro, D3,
 *        Goldshell LT Lite, LT5, E-DG1M,
 *        Bitdeer Sealminer DL1, Fluminer L1
 *
 * HOW DETECTION WORKS:
 *   The Stratum mining.subscribe message includes a user-agent string
 *   as the second parameter. Format varies by manufacturer firmware:
 *     Bitmain:   "cgminer/4.11.1" or "bmminer/2.0.0 Antminer L9"
 *     ElphaPex:  "ElphaPex DG1+ v2.1.0" or "cgminer/5.0 DG2Plus"
 *     Goldshell: "goldshell-miner/2.2.1" or "cgminer LT6"
 *     Bitdeer:   "Sealminer/1.0.0 DL1"
 *     Fluminer:  "fluminer/1.0 L1"
 *     Unknown:   anything else → UNKNOWN tier, conservative defaults
 *
 * SECURITY NOTE:
 *   User-agent CAN be spoofed. Model detection is advisory only —
 *   it informs optimal difficulty starting point and vardiff floor.
 *   It is never used for access control or payment decisions.
 *
 * VARDIFF TIERS (for unknown/fallback assignment):
 *   HOME  < 2 GH/s  → startDiff: 8,192
 *   MID   2–8 GH/s  → startDiff: 32,768
 *   HIGH  8–20 GH/s → startDiff: 131,072
 *   PRO   20+ GH/s  → startDiff: 524,288
 */

const { createLogger } = require('../utils/logger');
const log = createLogger('miner-registry');

// ─── Model database ───────────────────────────────────────────────────────────

const MODELS = {

  // ══════════════════════════════════════════════════════
  // BITMAIN ANTMINER — SCRYPT SERIES
  // ══════════════════════════════════════════════════════

  'antminer-l9': {
    name: 'Antminer L9',
    manufacturer: 'Bitmain',
    tier: 'HIGH',
    expectedHashrateGhs: 16,
    optimalDifficulty: 131072,
    vardiffFloor: 65536,
    power: 3360,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      // (?![\dh]) rejects "L9H" (U2L9H); (?!\s*hydro) rejects "L9 Hydro"
      /antminer[-_\s]*l9(?![\dh])(?!\s*hydro)/i,
      /bitmain.*l9(?![\dh])(?!\s*hydro)/i,
      /bmminer.*l9(?![\dh])(?!\s*hydro)/i,
      /cgminer.*l9(?![\dh])(?!\s*hydro)/i,
    ],
    firmware: {
      current: '2025.11.1',
      supported: ['2025.11.1', '2025.08.2', '2025.05.1', '2024.12.1'],
      critical: ['2024.06.0'],
    },
  },

  'antminer-l11-pro': {
    name: 'Antminer L11 Pro',
    manufacturer: 'Bitmain',
    tier: 'PRO',
    expectedHashrateGhs: 21,
    optimalDifficulty: 524288,
    vardiffFloor: 262144,
    power: 3612,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      /antminer[-_\s]*l11[-_\s]*pro/i,
      /bmminer.*l11.*pro/i,
      /cgminer.*l11.*pro/i,
    ],
    firmware: {
      current: '2025.03.1',
      supported: ['2025.03.1'],
      critical: [],
    },
  },

  'antminer-l11-hydro': {
    name: 'Antminer L11 Hydro',
    manufacturer: 'Bitmain',
    tier: 'PRO',
    expectedHashrateGhs: 33,
    optimalDifficulty: 524288,
    vardiffFloor: 524288,
    power: 5676,
    cooling: 'hydro',
    algorithm: 'scrypt',
    patterns: [
      /antminer[-_\s]*l11[-_\s]*hydro/i,
      /bmminer.*l11.*hydro/i,
      /cgminer.*l11.*hydro/i,
    ],
    firmware: {
      current: '2025.03.1',
      supported: ['2025.03.1'],
      critical: [],
    },
  },

  'antminer-l11': {
    name: 'Antminer L11',
    manufacturer: 'Bitmain',
    tier: 'PRO',
    expectedHashrateGhs: 20,
    optimalDifficulty: 524288,
    vardiffFloor: 262144,
    power: 3680,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      // NOTE: must come AFTER l11-pro and l11-hydro to avoid false matches
      /antminer[-_\s]*l11(?![\s-]*pro)(?![\s-]*hydro)/i,
      /bmminer.*l11(?![\s-]*pro)(?![\s-]*hydro)/i,
      /cgminer.*l11(?![\s-]*pro)(?![\s-]*hydro)/i,
    ],
    firmware: {
      current: '2025.03.1',
      supported: ['2025.03.1', '2025.01.1'],
      critical: [],
    },
  },

  'antminer-u2l9h': {
    name: 'Antminer U2L9H',
    manufacturer: 'Bitmain',
    tier: 'PRO',
    expectedHashrateGhs: 27,
    optimalDifficulty: 524288,
    vardiffFloor: 262144,
    power: 5670,
    cooling: 'hydro',
    algorithm: 'scrypt',
    patterns: [
      /u2l9h/i,
      /antminer.*2u.*l9/i,
      /antminer.*l9.*hydro/i,
      /bmminer.*u2l9/i,
    ],
    firmware: {
      current: '2025.05.1',
      supported: ['2025.05.1', '2025.01.1'],
      critical: [],
    },
  },

  'antminer-l7-pro': {
    name: 'Antminer L7 Pro',
    manufacturer: 'Bitmain',
    tier: 'HIGH',
    expectedHashrateGhs: 9.5,
    optimalDifficulty: 131072,
    vardiffFloor: 65536,
    power: 3425,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      /antminer[-_\s]*l7[-_\s]*pro/i,
      /bmminer.*l7.*pro/i,
      /cgminer.*l7.*pro/i,
      /antminer[-_\s]*l7.*9\.5/i,
    ],
    firmware: {
      current: '2024.08.1',
      supported: ['2024.08.1', '2024.03.1'],
      critical: [],
    },
  },

  'antminer-l7': {
    name: 'Antminer L7',
    manufacturer: 'Bitmain',
    tier: 'HIGH',
    expectedHashrateGhs: 9.16,
    optimalDifficulty: 131072,
    vardiffFloor: 32768,
    power: 3425,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      // NOTE: must come AFTER l7-pro
      /antminer[-_\s]*l7(?![-_\s]*pro)(?!.*9\.5)/i,
      /bitmain.*l7(?![-_\s]*pro)/i,
      /bmminer.*l7(?![-_\s]*pro)/i,
      /cgminer.*l7(?![-_\s]*pro)/i,
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
    tier: 'HOME',
    expectedHashrateGhs: 0.504,
    optimalDifficulty: 512,
    vardiffFloor: 256,
    power: 800,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      /antminer[-_\s]*l3\+/i,
      /antminer[-_\s]*l3plus/i,
      /antminer[-_\s]*l3p/i,
      /bitmain.*l3/i,
      /cgminer.*l3/i,
    ],
    firmware: {
      current: '2019.12.1',
      supported: ['2019.12.1', '2019.06.1'],
      critical: ['2017.11.0'],
    },
  },

  // ══════════════════════════════════════════════════════
  // ELPHAPEX — DG SERIES
  // ══════════════════════════════════════════════════════

  'elphapex-dg2plus': {
    name: 'ElphaPex DG2+',
    manufacturer: 'ElphaPex',
    tier: 'PRO',
    expectedHashrateGhs: 20.5,
    optimalDifficulty: 524288,
    vardiffFloor: 262144,
    power: 3900,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      /elphapex[-_\s]*dg2\+/i,
      /elphapex[-_\s]*dg2plus/i,
      /dg2\+/i,
      /dg2plus/i,
    ],
    firmware: {
      current: '2.0.0',
      supported: ['2.0.0', '1.9.0'],
      critical: [],
    },
  },

  'elphapex-dg2': {
    name: 'ElphaPex DG2',
    manufacturer: 'ElphaPex',
    tier: 'PRO',
    expectedHashrateGhs: 20,
    optimalDifficulty: 524288,
    vardiffFloor: 131072,
    power: 2800,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      // NOTE: must come AFTER dg2plus
      /elphapex[-_\s]*dg2(?!\+)(?!plus)/i,
      /(?<!\+)dg2(?!\+)(?!plus)/i,
    ],
    firmware: {
      current: '1.4.0',
      supported: ['1.4.0', '1.3.0', '1.2.0'],
      critical: [],
    },
  },

  'elphapex-dg-hydro1': {
    name: 'ElphaPex DG Hydro 1',
    manufacturer: 'ElphaPex',
    tier: 'PRO',
    expectedHashrateGhs: 20,
    optimalDifficulty: 524288,
    vardiffFloor: 131072,
    power: 6200,
    cooling: 'hydro',
    algorithm: 'scrypt',
    patterns: [
      /elphapex[-_\s]*dg[-_\s]*hydro[-_\s]*1/i,
      /dg[-_\s]*hydro[-_\s]*1/i,
      /dghydro1/i,
      /elphapex.*hydro/i,
    ],
    firmware: {
      current: '1.2.0',
      supported: ['1.2.0', '1.1.0'],
      critical: [],
    },
  },

  'elphapex-dg1plus': {
    name: 'ElphaPex DG1+',
    manufacturer: 'ElphaPex',
    tier: 'HIGH',
    expectedHashrateGhs: 14.4,
    optimalDifficulty: 131072,
    vardiffFloor: 65536,
    power: 3950,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      /elphapex[-_\s]*dg1\+/i,
      /elphapex[-_\s]*dg1plus/i,
      /dg1\+/i,
      /dg1plus/i,
    ],
    firmware: {
      current: '2.1.0',
      supported: ['2.1.0', '2.0.0'],
      critical: [],
    },
  },

  'elphapex-dg1': {
    name: 'ElphaPex DG1',
    manufacturer: 'ElphaPex',
    tier: 'HIGH',
    expectedHashrateGhs: 14,
    optimalDifficulty: 65536,
    vardiffFloor: 32768,
    power: 2000,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      // NOTE: must come AFTER dg1plus
      /elphapex[-_\s]*dg1(?!\+)(?!plus)/i,
      /(?<!\+)dg1(?!\+)(?!plus)(?!m)/i,
    ],
    firmware: {
      current: '1.3.0',
      supported: ['1.3.0', '1.2.0'],
      critical: [],
    },
  },

  'elphapex-dg-home1': {
    name: 'ElphaPex DG Home 1',
    manufacturer: 'ElphaPex',
    tier: 'MID',
    expectedHashrateGhs: 6,
    optimalDifficulty: 32768,
    vardiffFloor: 8192,
    power: 1500,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      /elphapex[-_\s]*dg[-_\s]*home[-_\s]*1/i,
      /dg[-_\s]*home[-_\s]*1/i,
      /dghome1/i,
    ],
    firmware: {
      current: '1.1.0',
      supported: ['1.1.0', '1.0.0'],
      critical: [],
    },
  },

  // ══════════════════════════════════════════════════════
  // VOLCMINER
  // ══════════════════════════════════════════════════════

  'volcminer-d1-hydro': {
    name: 'VolcMiner D1 Hydro',
    manufacturer: 'VolcMiner',
    tier: 'PRO',
    expectedHashrateGhs: 30.4,
    optimalDifficulty: 524288,
    vardiffFloor: 524288,
    power: 7600,
    cooling: 'hydro',
    algorithm: 'scrypt',
    patterns: [
      /volcminer[-_\s]*d1[-_\s]*hydro/i,
      /volc[-_\s]*d1[-_\s]*hydro/i,
      /d1[-_\s]*hydro/i,
    ],
    firmware: {
      current: '3.0.0',
      supported: ['3.0.0', '2.2.0'],
      critical: [],
    },
  },

  'volcminer-d3': {
    name: 'VolcMiner D3',
    manufacturer: 'VolcMiner',
    tier: 'PRO',
    expectedHashrateGhs: 20,
    optimalDifficulty: 524288,
    vardiffFloor: 131072,
    power: 3560,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      /volcminer[-_\s]*d3/i,
      /volc[-_\s]*d3/i,
    ],
    firmware: {
      current: '2.1.0',
      supported: ['2.1.0', '2.0.0'],
      critical: [],
    },
  },

  'volcminer-d1': {
    name: 'VolcMiner D1',
    manufacturer: 'VolcMiner',
    tier: 'MID',
    expectedHashrateGhs: 5,
    optimalDifficulty: 32768,
    vardiffFloor: 8192,
    power: 1200,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      // NOTE: must come AFTER d1-hydro and d3
      /volcminer[-_\s]*d1(?![-_\s]*hydro)/i,
      /volc[-_\s]*d1(?![-_\s]*hydro)/i,
    ],
    firmware: {
      current: '2.1.0',
      supported: ['2.1.0', '2.0.0'],
      critical: [],
    },
  },

  // ══════════════════════════════════════════════════════
  // GOLDSHELL — LT SERIES
  // ══════════════════════════════════════════════════════

  'goldshell-lt6': {
    name: 'Goldshell LT6',
    manufacturer: 'Goldshell',
    tier: 'MID',
    expectedHashrateGhs: 8.5,
    optimalDifficulty: 32768,
    vardiffFloor: 16384,
    power: 3350,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      /goldshell[-_\s]*lt6/i,
      /goldshell.*lt6/i,
      /lt6(?!pro)/i,
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
    tier: 'MID',
    expectedHashrateGhs: 6,
    optimalDifficulty: 32768,
    vardiffFloor: 8192,
    power: 2400,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      /goldshell[-_\s]*lt5[-_\s]*pro/i,
      /lt5[-_\s]*pro/i,
      /lt5pro/i,
    ],
    firmware: {
      current: '2.2.1',
      supported: ['2.2.1', '2.1.0'],
      critical: [],
    },
  },

  'goldshell-lt5': {
    name: 'Goldshell LT5',
    manufacturer: 'Goldshell',
    tier: 'MID',
    expectedHashrateGhs: 4.3,
    optimalDifficulty: 32768,
    vardiffFloor: 8192,
    power: 1700,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      // NOTE: must come AFTER lt5pro
      /goldshell[-_\s]*lt5(?![-_\s]*pro)(?!pro)/i,
      /(?<!pro[-_\s]*)lt5(?![-_\s]*pro)(?!pro)/i,
    ],
    firmware: {
      current: '2.1.0',
      supported: ['2.1.0', '2.0.0'],
      critical: [],
    },
  },

  'goldshell-lt-lite': {
    name: 'Goldshell LT Lite',
    manufacturer: 'Goldshell',
    tier: 'HOME',
    expectedHashrateGhs: 2,
    optimalDifficulty: 8192,
    vardiffFloor: 2048,
    power: 600,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      /goldshell[-_\s]*lt[-_\s]*lite/i,
      /lt[-_\s]*lite/i,
      /ltlite/i,
    ],
    firmware: {
      current: '1.1.0',
      supported: ['1.1.0', '1.0.0'],
      critical: [],
    },
  },

  'goldshell-edg1m': {
    name: 'Goldshell E-DG1M',
    manufacturer: 'Goldshell',
    tier: 'HOME',
    expectedHashrateGhs: 1.2,
    optimalDifficulty: 8192,
    vardiffFloor: 1024,
    power: 400,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      /goldshell[-_\s]*e[-_]?dg1m/i,
      /e[-_]?dg1m/i,
      /edg1m/i,
    ],
    firmware: {
      current: '1.0.0',
      supported: ['1.0.0'],
      critical: [],
    },
  },

  // ══════════════════════════════════════════════════════
  // BITDEER — SEALMINER
  // ══════════════════════════════════════════════════════

  'bitdeer-sealminer-dl1': {
    name: 'Bitdeer Sealminer DL1',
    manufacturer: 'Bitdeer',
    tier: 'HIGH',
    expectedHashrateGhs: 12,
    optimalDifficulty: 131072,
    vardiffFloor: 32768,
    power: 2800,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      /sealminer[-_\s]*dl1/i,
      /bitdeer.*dl1/i,
      /dl1[-_\s]*air/i,
      /sealminer.*dl/i,
    ],
    firmware: {
      current: '1.1.0',
      supported: ['1.1.0', '1.0.0'],
      critical: [],
    },
  },

  // ══════════════════════════════════════════════════════
  // FLUMINER
  // ══════════════════════════════════════════════════════

  'fluminer-l1': {
    name: 'Fluminer L1',
    manufacturer: 'Fluminer',
    tier: 'MID',
    expectedHashrateGhs: 5.6,
    optimalDifficulty: 32768,
    vardiffFloor: 8192,
    power: 1300,
    cooling: 'air',
    algorithm: 'scrypt',
    patterns: [
      /fluminer[-_\s]*l1/i,
      /fluminer.*l1/i,
    ],
    firmware: {
      current: '1.0.0',
      supported: ['1.0.0'],
      critical: [],
    },
  },
};

// ─── Vardiff tier fallback table (for unrecognized miners) ────────────────────

const UNKNOWN_DEFAULTS = {
  optimalDifficulty: 32768,
  vardiffFloor: 8192,
};

// ─── Pattern match order ─────────────────────────────────────────────────────
// Models are evaluated in insertion order (V8 preserves this for non-integer
// keys). More specific patterns must appear before base variants.

const MODEL_KEYS = Object.keys(MODELS);

// ─── MinerRegistry class ─────────────────────────────────────────────────────

class MinerRegistry {
  constructor() {
    this.models = MODELS;
    this.unknownDefaults = UNKNOWN_DEFAULTS;
    this._cache = new Map();
    this._cacheMax = 2000;
  }

  /**
   * Identify miner model from the user-agent string sent in mining.subscribe.
   */
  identify(userAgent) {
    if (!userAgent || typeof userAgent !== 'string') return null;

    const ua = userAgent.trim();

    if (this._cache.has(ua)) {
      const key = this._cache.get(ua);
      return key ? { key, ...this.models[key] } : null;
    }

    for (const key of MODEL_KEYS) {
      for (const pattern of this.models[key].patterns) {
        if (pattern.test(ua)) {
          this._cacheSet(ua, key);
          log.info({ model: this.models[key].name, userAgent: ua }, 'Miner model identified');
          return { key, ...this.models[key] };
        }
      }
    }

    this._cacheSet(ua, null);
    log.debug({ userAgent: ua }, 'Unknown miner model — applying universal defaults');
    return null;
  }

  /** Extract firmware version from user-agent string. */
  extractFirmwareVersion(userAgent) {
    if (!userAgent) return null;

    const patterns = [
      /(?:cgminer|bmminer|cpuminer|sgminer|fluminer|sealminer)[/\s](\d+\.\d+\.\d+)/i,
      /[vV](\d+\.\d+\.\d+)/,
      /(\d{4}\.\d{1,2}\.\d+)/,
      /(\d+\.\d+\.\d+)/,
    ];

    for (const p of patterns) {
      const m = userAgent.match(p);
      if (m) return m[1];
    }
    return null;
  }

  /** Check firmware status for a detected model. */
  checkFirmwareStatus(modelKey, version) {
    const model = this.models[modelKey];
    if (!model || !version) return { outdated: false, critical: false, current: null, supported: false };

    return {
      outdated: version !== model.firmware.current,
      critical: model.firmware.critical.includes(version),
      current: model.firmware.current,
      supported: model.firmware.supported.includes(version),
    };
  }

  /** Get the optimal starting difficulty for a model. */
  getOptimalDifficulty(modelKey) {
    if (!modelKey || !this.models[modelKey]) return this.unknownDefaults.optimalDifficulty;
    return this.models[modelKey].optimalDifficulty;
  }

  /** Get the vardiff floor for a model. */
  getVardiffFloor(modelKey) {
    if (!modelKey || !this.models[modelKey]) return this.unknownDefaults.vardiffFloor;
    return this.models[modelKey].vardiffFloor;
  }

  /** Get expected hashrate in GH/s for efficiency monitoring. */
  getExpectedHashrate(modelKey) {
    if (!modelKey || !this.models[modelKey]) return null;
    return this.models[modelKey].expectedHashrateGhs;
  }

  /** Get tier string for a model key (HOME|MID|HIGH|PRO). */
  getTier(modelKey) {
    if (!modelKey || !this.models[modelKey]) return 'UNKNOWN';
    return this.models[modelKey].tier;
  }

  /** Returns a summary of all registered models for API/dashboard use. */
  listModels() {
    return MODEL_KEYS.map(key => {
      const m = this.models[key];
      return {
        key,
        name: m.name,
        manufacturer: m.manufacturer,
        tier: m.tier,
        expectedHashrateGhs: m.expectedHashrateGhs,
        optimalDifficulty: m.optimalDifficulty,
        vardiffFloor: m.vardiffFloor,
        power: m.power,
        cooling: m.cooling,
      };
    });
  }

  // ─── Back-compat aliases (v0.7.x callers still using these names) ─────────
  getAllModels()               { return this.listModels(); }
  getDifficultyFloor(modelKey) { return this.getVardiffFloor(modelKey); }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _cacheSet(ua, key) {
    if (this._cache.size >= this._cacheMax) {
      this._cache.delete(this._cache.keys().next().value);
    }
    this._cache.set(ua, key);
  }
}

module.exports = new MinerRegistry();
