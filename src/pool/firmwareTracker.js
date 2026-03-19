/**
 * LUXXPOOL v0.7.0 — Firmware Tracker
 * Tracks miner firmware versions across connected miners,
 * persists to database, and sends update advisories via
 * Stratum client.show_message.
 */

const { createLogger } = require('../utils/logger');

const log = createLogger('firmware');

class FirmwareTracker {
  /**
   * @param {object} db - Database query interface
   * @param {object} minerRegistry - MinerRegistry instance
   */
  constructor(db, minerRegistry) {
    this.db = db;
    this.minerRegistry = minerRegistry;
    this.connected = new Map(); // clientId → { address, workerName, modelKey, firmware, userAgent }
    this.timer = null;
  }

  start() {
    // Persist firmware stats every 5 minutes
    this.timer = setInterval(() => this._persistAll(), 300000);
    log.info('Firmware tracker started');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Called when a miner connects and sends mining.subscribe with a user-agent.
   * Parses the user-agent, stores firmware info, returns update recommendation.
   * @param {string} clientId
   * @param {string} userAgent
   * @param {string} address - Miner's LTC address
   * @param {string} workerName - Full worker name (address.worker)
   * @returns {{ parsed: object, recommendation: object }}
   */
  onMinerConnect(clientId, userAgent, address, workerName) {
    const parsed = this.minerRegistry.parseUserAgent(userAgent);

    this.connected.set(clientId, {
      address,
      workerName,
      modelKey: parsed.modelKey,
      model: parsed.model,
      firmware: parsed.firmware,
      software: parsed.software,
      userAgent,
      connectedAt: Date.now(),
    });

    const recommendation = parsed.modelKey
      ? this.minerRegistry.getUpdateRecommendation(parsed.modelKey, parsed.firmware)
      : { available: false, version: null, urgency: null };

    if (parsed.modelKey) {
      log.info({
        clientId: clientId.substring(0, 8),
        model: parsed.model,
        firmware: parsed.firmware,
        updateAvailable: recommendation.available,
      }, 'Miner model identified');
    }

    return { parsed, recommendation };
  }

  /**
   * Called when a miner disconnects.
   * @param {string} clientId
   */
  onMinerDisconnect(clientId) {
    this.connected.delete(clientId);
  }

  /**
   * Refine a miner's model detection after hashrate observation.
   * @param {string} clientId
   * @param {number} observedHashrate
   * @returns {string|null} New model key if refined, null otherwise
   */
  refineModel(clientId, observedHashrate) {
    const entry = this.connected.get(clientId);
    if (!entry) return null;

    const refined = this.minerRegistry.refineModelByHashrate(entry.modelKey, observedHashrate);
    if (refined && refined !== entry.modelKey) {
      entry.modelKey = refined;
      const profile = this.minerRegistry.getProfile(refined);
      entry.model = profile ? profile.name : entry.model;
      log.info({
        clientId: clientId.substring(0, 8),
        oldModel: entry.model,
        newModel: profile?.name,
        hashrate: observedHashrate,
      }, 'Miner model refined by hashrate');
      return refined;
    }
    return null;
  }

  /**
   * Build a Stratum client.show_message notification for firmware updates.
   * @param {string} modelKey
   * @param {string} currentFirmware
   * @returns {string|null} Message text, or null if no update available
   */
  buildUpdateMessage(modelKey, currentFirmware) {
    const rec = this.minerRegistry.getUpdateRecommendation(modelKey, currentFirmware);
    if (!rec.available) return null;

    const profile = this.minerRegistry.getProfile(modelKey);
    const name = profile ? profile.name : 'your miner';
    return `[LUXXPOOL] Firmware update available for ${name}: v${rec.version} (${rec.urgency}). Visit manufacturer site to update.`;
  }

  /**
   * Get aggregate firmware status across all connected miners.
   * @returns {{ total, identified, outdated, models: object }}
   */
  getFleetFirmwareStatus() {
    const models = {};
    let identified = 0;
    let outdated = 0;

    for (const [, entry] of this.connected) {
      if (entry.modelKey) {
        identified++;
        if (!models[entry.model]) {
          models[entry.model] = { count: 0, firmwareVersions: {}, outdated: 0 };
        }
        models[entry.model].count++;

        const fwKey = entry.firmware || 'unknown';
        models[entry.model].firmwareVersions[fwKey] =
          (models[entry.model].firmwareVersions[fwKey] || 0) + 1;

        if (this.minerRegistry.isOutdatedFirmware(entry.modelKey, entry.firmware)) {
          outdated++;
          models[entry.model].outdated++;
        }
      }
    }

    return {
      total: this.connected.size,
      identified,
      outdated,
      unidentified: this.connected.size - identified,
      models,
    };
  }

  /**
   * Get list of miners with outdated firmware.
   * @returns {Array<{ address, workerName, model, currentFirmware, latestFirmware }>}
   */
  getOutdatedMiners() {
    const result = [];

    for (const [, entry] of this.connected) {
      if (entry.modelKey && this.minerRegistry.isOutdatedFirmware(entry.modelKey, entry.firmware)) {
        const profile = this.minerRegistry.getProfile(entry.modelKey);
        result.push({
          address: entry.address,
          workerName: entry.workerName,
          model: entry.model,
          currentFirmware: entry.firmware,
          latestFirmware: profile?.latestFirmware?.version,
          urgency: profile?.latestFirmware?.urgency,
        });
      }
    }

    return result;
  }

  /**
   * Get firmware info for a specific connected miner.
   * @param {string} clientId
   * @returns {object|null}
   */
  getMinerInfo(clientId) {
    return this.connected.get(clientId) || null;
  }

  // ═══════════════════════════════════════════════════════
  // INTERNAL
  // ═══════════════════════════════════════════════════════

  async _persistAll() {
    for (const [, entry] of this.connected) {
      if (!entry.address) continue;
      try {
        await this.db.query(
          `INSERT INTO miner_firmware (address, worker_name, miner_model, firmware_version, user_agent, last_seen)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (address, worker_name)
           DO UPDATE SET miner_model = $3, firmware_version = $4, user_agent = $5, last_seen = NOW()`,
          [entry.address, entry.workerName, entry.model, entry.firmware, entry.userAgent]
        );
      } catch (err) {
        log.error({ err: err.message, address: entry.address }, 'Failed to persist firmware info');
      }
    }
  }
}

module.exports = FirmwareTracker;
