/**
 * LUXXPOOL — Fleet Management API Routes
 * Runtime fleet management: add miners, IPs, addresses without restart
 */

const { API } = require('../../ux/copy');
const { createLogger } = require('../../utils/logger');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { validateAddress } = require('../../utils/addressCodec');
const poolLogger = require('../../logging/poolLogger');
const log = createLogger('api:fleet');

// Octet-bounded IPv4 regex — the previous regex accepted invalid octets like
// 999.999.999.999/33 because it only checked digit counts, not values.
function isValidIpOrCidr(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(\d{1,2}))?$/.exec(s);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) if (parseInt(m[i], 10) > 255) return false;
  if (m[6] !== undefined && parseInt(m[6], 10) > 32) return false;
  return true;
}

function registerFleetRoutes(app, deps) {
  const { fleetManager } = deps;
  if (!fleetManager) return;

  // Fleet overview
  app.get('/api/v1/fleet/overview', (req, res) => {
    res.json(fleetManager.getOverview());
  });

  // Fleet miners detail (admin — exposes individual miner data)
  app.get('/api/v1/fleet/miners', requireAdminAuth, (req, res) => {
    res.json(fleetManager.getFleetStats());
  });

  // Public miner stats (aggregate only — safe to expose)
  app.get('/api/v1/fleet/public', (req, res) => {
    res.json(fleetManager.getPublicStats());
  });

  // Fleet configuration (admin — exposes IP/address whitelist)
  app.get('/api/v1/fleet/config', requireAdminAuth, (req, res) => {
    res.json(fleetManager.getConfig());
  });

  // Classify an IP/address (admin — reveals fleet classification logic)
  app.get('/api/v1/fleet/check', requireAdminAuth, (req, res) => {
    const { ip, address } = req.query;
    res.json({
      ip, address,
      classification: fleetManager.classify(ip || '', address || ''),
      fee: fleetManager.getFee(ip || '', address || ''),
    });
  });

  // ═══════════════════════════════════════════════════════
  // RUNTIME FLEET MANAGEMENT (no restart required)
  // ═══════════════════════════════════════════════════════

  // Add IP or CIDR to fleet whitelist
  // POST /api/v1/fleet/ip { "ip": "203.0.113.50" }
  // POST /api/v1/fleet/ip { "ip": "10.0.0.0/24" }
  app.post('/api/v1/fleet/ip', requireAdminAuth, (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: API.validation.IP_REQUIRED, code: 'VALIDATION_ERROR' });
    if (!isValidIpOrCidr(ip)) {
      return res.status(400).json({ error: 'Invalid IP or CIDR format', code: 'VALIDATION_ERROR' });
    }

    const success = fleetManager.addIp(ip);
    log.warn({ ip, sourceIp: req.ip }, 'FLEET MUTATION: IP added via API');
    try { poolLogger.emit('FLEET_001', { action: 'add_ip', ip, sourceIp: req.ip }); } catch (err) {
      log.debug({ err: err.message }, 'poolLogger emit FLEET_001 failed');
    }
    res.json({ success, config: fleetManager.getConfig() });
  });

  // Remove IP from fleet whitelist
  // DELETE /api/v1/fleet/ip { "ip": "203.0.113.50" }
  app.delete('/api/v1/fleet/ip', requireAdminAuth, (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: API.validation.IP_REQUIRED, code: 'VALIDATION_ERROR' });
    if (!isValidIpOrCidr(ip)) {
      return res.status(400).json({ error: 'Invalid IP or CIDR format', code: 'VALIDATION_ERROR' });
    }

    const success = fleetManager.removeIp(ip);
    log.warn({ ip, sourceIp: req.ip }, 'FLEET MUTATION: IP removed via API');
    try { poolLogger.emit('FLEET_001', { action: 'remove_ip', ip, sourceIp: req.ip }); } catch (err) {
      log.debug({ err: err.message }, 'poolLogger emit FLEET_001 failed');
    }
    res.json({ success, config: fleetManager.getConfig() });
  });

  // Add LTC address to fleet whitelist
  // POST /api/v1/fleet/address { "address": "LhXk7..." }
  app.post('/api/v1/fleet/address', requireAdminAuth, (req, res) => {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: API.validation.ADDRESS_REQUIRED, code: 'VALIDATION_ERROR' });

    // Admin token compromise + unvalidated address = direct fee theft.
    const v = validateAddress(address);
    if (!v.valid) {
      return res.status(400).json({ error: `Invalid address: ${v.error}`, code: 'VALIDATION_ERROR' });
    }

    const success = fleetManager.addAddress(address);
    log.warn({ address, type: v.type, sourceIp: req.ip }, 'FLEET MUTATION: address added via API');
    try { poolLogger.emit('FLEET_001', { action: 'add_address', address, sourceIp: req.ip }); } catch (err) {
      log.debug({ err: err.message }, 'poolLogger emit FLEET_001 failed');
    }
    res.json({ success, config: fleetManager.getConfig() });
  });

  // Remove address from fleet whitelist
  // DELETE /api/v1/fleet/address { "address": "LhXk7..." }
  app.delete('/api/v1/fleet/address', requireAdminAuth, (req, res) => {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: API.validation.ADDRESS_REQUIRED, code: 'VALIDATION_ERROR' });

    const v = validateAddress(address);
    if (!v.valid) {
      return res.status(400).json({ error: `Invalid address: ${v.error}`, code: 'VALIDATION_ERROR' });
    }

    const success = fleetManager.removeAddress(address);
    log.warn({ address, sourceIp: req.ip }, 'FLEET MUTATION: address removed via API');
    try { poolLogger.emit('FLEET_001', { action: 'remove_address', address, sourceIp: req.ip }); } catch (err) {
      log.debug({ err: err.message }, 'poolLogger emit FLEET_001 failed');
    }
    res.json({ success, config: fleetManager.getConfig() });
  });

  // Update fleet capacity
  // PUT /api/v1/fleet/capacity { "max": 200 }
  app.put('/api/v1/fleet/capacity', requireAdminAuth, (req, res) => {
    const { max } = req.body;
    // Hard upper bound to prevent accidental fleet-bloat from a typo or a
    // compromised admin token.
    if (!Number.isInteger(max) || max < 1 || max > 10000) {
      return res.status(400).json({ error: 'max must be an integer in 1..10000', code: 'VALIDATION_ERROR' });
    }

    fleetManager.setMaxMiners(max);
    log.warn({ max, sourceIp: req.ip }, 'FLEET MUTATION: capacity changed via API');
    try { poolLogger.emit('FLEET_002', { action: 'set_capacity', max, sourceIp: req.ip }); } catch (err) {
      log.debug({ err: err.message }, 'poolLogger emit FLEET_002 failed');
    }
    res.json({ maxMiners: max, config: fleetManager.getConfig() });
  });
}

module.exports = { registerFleetRoutes };
