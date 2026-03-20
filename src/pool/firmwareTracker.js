/**
 * LUXXPOOL v0.7.0 — Firmware Tracker
 * ═══════════════════════════════════════════════════════════
 * Tracks firmware versions for connected miners and sends
 * update advisories via Stratum client.show_message.
 *
 * Security Context:
 *   - ASIC firmware compromise is a HIGH-probability threat
 *   - Antminer L9 runs Angstrom Linux with known vulnerabilities:
 *     unsigned firmware upgrades, default SSH (root/root), CGI as root
 *   - All units should have default passwords changed, SSH disabled
 *   - Firmware advisories sent on authorize (user preference)
 */

const { createLogger } = require('../utils/logger');

const log = createLogger('firmware');

class FirmwareTracker {
  /**
   * @param {object} deps - { minerRegistry, db, auditLog }
   * @param {object} opts
   */
  constructor(deps = {}, opts = {}) {
    this.minerRegistry = deps.minerRegistry;
    this.db = deps.db;
    this.auditLog = deps.auditLog;

    this.rescanIntervalMs = opts.rescanIntervalMs || 300000; // 5 min

    // Active tracked miners: clientId → { model, firmwareVersion, status, advisorySent }
    this.tracked = new Map();

    this.rescanTimer = null;
  }

  start() {
    this.rescanTimer = setInterval(() => this._rescan(), this.rescanIntervalMs);
    log.info('Firmware tracker started');
  }

  stop() {
    if (this.rescanTimer) clearInterval(this.rescanTimer);
  }

  /**
   * Check firmware on miner authorize and send advisory if outdated.
   * Called immediately when a miner authorizes (user preference: on-authorize).
   *
   * @param {object} client - StratumClient
   * @param {object} model - Model profile from minerRegistry.identify()
   * @param {string} firmwareVersion - Extracted firmware version
   */
  checkAndAdvisory(client, model, firmwareVersion) {
    if (!model || !firmwareVersion) return;

    const status = this.minerRegistry.checkFirmwareStatus(model.key, firmwareVersion);

    this.tracked.set(client.id, {
      clientId: client.id,
      address: client.minerAddress,
      ip: client.remoteAddress,
      modelKey: model.key,
      modelName: model.name,
      firmwareVersion,
      status,
      advisorySent: false,
      detectedAt: Date.now(),
    });

    // Send advisory if outdated
    if (status.outdated) {
      this._sendAdvisory(client, model, firmwareVersion, status);
    }

    // Persist to database
    this._persist(client.minerAddress, model, firmwareVersion);

    // Audit critical firmware
    if (status.critical && this.auditLog) {
      this.auditLog.firmware('critical_firmware', {
        ip: client.remoteAddress,
        address: client.minerAddress,
        model: model.name,
        version: firmwareVersion,
        critical: true,
      });
    }
  }

  /**
   * Remove tracking on disconnect.
   */
  onDisconnect(clientId) {
    this.tracked.delete(clientId);
  }

  /**
   * Get firmware status distribution for dashboard.
   */
  getDistribution() {
    const distribution = {
      total: this.tracked.size,
      current: 0,
      outdated: 0,
      critical: 0,
      unknown: 0,
      byModel: {},
    };

    for (const [, entry] of this.tracked) {
      if (!entry.status) {
        distribution.unknown++;
        continue;
      }

      if (entry.status.critical) distribution.critical++;
      else if (entry.status.outdated) distribution.outdated++;
      else distribution.current++;

      // By model breakdown
      if (!distribution.byModel[entry.modelName]) {
        distribution.byModel[entry.modelName] = { current: 0, outdated: 0, critical: 0, total: 0 };
      }
      const modelDist = distribution.byModel[entry.modelName];
      modelDist.total++;
      if (entry.status.critical) modelDist.critical++;
      else if (entry.status.outdated) modelDist.outdated++;
      else modelDist.current++;
    }

    return distribution;
  }

  /**
   * Get all tracked miners for admin view.
   */
  getTrackedMiners() {
    return Array.from(this.tracked.values()).map(entry => ({
      address: entry.address,
      model: entry.modelName,
      firmware: entry.firmwareVersion,
      outdated: entry.status?.outdated || false,
      critical: entry.status?.critical || false,
      currentVersion: entry.status?.current || null,
      advisorySent: entry.advisorySent,
    }));
  }

  // ─── Internal ──────────────────────────────────────────

  /**
   * Send Stratum client.show_message advisory for outdated firmware.
   */
  _sendAdvisory(client, model, version, status) {
    const entry = this.tracked.get(client.id);
    if (!entry || entry.advisorySent) return;

    let message;
    if (status.critical) {
      message = `[LUXXPOOL SECURITY] CRITICAL: Your ${model.name} firmware ${version} has known vulnerabilities. Update to ${status.current} immediately. Visit manufacturer support for instructions.`;
    } else {
      message = `[LUXXPOOL] Your ${model.name} firmware ${version} is outdated. Latest version: ${status.current}. Consider updating for optimal performance.`;
    }

    // Send via Stratum client.show_message extension
    try {
      if (client.socket && client.socket.writable) {
        client._sendNotification('client.show_message', [message]);
        entry.advisorySent = true;

        log.info({
          address: client.minerAddress,
          model: model.name,
          firmware: version,
          critical: status.critical,
        }, status.critical ? 'CRITICAL firmware advisory sent' : 'Firmware update advisory sent');
      }
    } catch (err) {
      log.debug({ err: err.message }, 'Failed to send firmware advisory');
    }
  }

  /**
   * Persist miner model/firmware to database.
   */
  async _persist(address, model, firmwareVersion) {
    if (!this.db) return;

    try {
      await this.db.query(
        `INSERT INTO miner_models (address, model, firmware_version, optimal_difficulty, expected_hashrate, last_seen)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT ON CONSTRAINT miner_models_address_model_unique
         DO UPDATE SET firmware_version = $3, last_seen = NOW()`,
        [address, model.name, firmwareVersion, model.optimalDifficulty, model.expectedHashrate]
      ).catch(() => {
        // If unique constraint doesn't exist, try plain insert/update
        return this.db.query(
          `INSERT INTO miner_models (address, model, firmware_version, optimal_difficulty, expected_hashrate, last_seen)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [address, model.name, firmwareVersion, model.optimalDifficulty, model.expectedHashrate]
        );
      });
    } catch (err) {
      log.debug({ err: err.message }, 'Firmware persist failed');
    }
  }

  /**
   * Periodic rescan of connected miners — re-check firmware status
   * in case known-good versions list has been updated.
   */
  _rescan() {
    for (const [, entry] of this.tracked) {
      if (entry.modelKey && entry.firmwareVersion) {
        entry.status = this.minerRegistry.checkFirmwareStatus(entry.modelKey, entry.firmwareVersion);
      }
    }
  }
}

module.exports = FirmwareTracker;
