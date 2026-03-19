/**
const { API } = require('../../ux/copy');
 * LUXXPOOL v0.5.2 — Fleet Management API Routes
 * Runtime fleet management: add miners, IPs, addresses without restart
 */

const { createLogger } = require('../../utils/logger');
const log = createLogger('api:fleet');

function registerFleetRoutes(app, deps) {
  const { fleetManager } = deps;
  if (!fleetManager) return;

  // Fleet overview
  app.get('/api/v1/fleet/overview', (req, res) => {
    res.json(fleetManager.getOverview());
  });

  // Fleet miners detail
  app.get('/api/v1/fleet/miners', (req, res) => {
    res.json(fleetManager.getFleetStats());
  });

  // Public miner stats
  app.get('/api/v1/fleet/public', (req, res) => {
    res.json(fleetManager.getPublicStats());
  });

  // Fleet configuration (current whitelist)
  app.get('/api/v1/fleet/config', (req, res) => {
    res.json(fleetManager.getConfig());
  });

  // Classify an IP/address
  app.get('/api/v1/fleet/check', (req, res) => {
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
  app.post('/api/v1/fleet/ip', (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: API.validation.IP_REQUIRED, code: 'VALIDATION_ERROR' });

    const success = fleetManager.addIp(ip);
    log.info({ ip }, 'Fleet IP added via API');
    res.json({ success, config: fleetManager.getConfig() });
  });

  // Remove IP from fleet whitelist
  // DELETE /api/v1/fleet/ip { "ip": "203.0.113.50" }
  app.delete('/api/v1/fleet/ip', (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: API.validation.IP_REQUIRED, code: 'VALIDATION_ERROR' });

    const success = fleetManager.removeIp(ip);
    res.json({ success, config: fleetManager.getConfig() });
  });

  // Add LTC address to fleet whitelist
  // POST /api/v1/fleet/address { "address": "LhXk7..." }
  app.post('/api/v1/fleet/address', (req, res) => {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: API.validation.ADDRESS_REQUIRED, code: 'VALIDATION_ERROR' });

    const success = fleetManager.addAddress(address);
    log.info({ address }, 'Fleet address added via API');
    res.json({ success, config: fleetManager.getConfig() });
  });

  // Remove address from fleet whitelist
  // DELETE /api/v1/fleet/address { "address": "LhXk7..." }
  app.delete('/api/v1/fleet/address', (req, res) => {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: API.validation.ADDRESS_REQUIRED, code: 'VALIDATION_ERROR' });

    const success = fleetManager.removeAddress(address);
    res.json({ success, config: fleetManager.getConfig() });
  });

  // Update fleet capacity
  // PUT /api/v1/fleet/capacity { "max": 200 }
  app.put('/api/v1/fleet/capacity', (req, res) => {
    const { max } = req.body;
    if (!max || max < 1) return res.status(400).json({ error: API.validation.MAX_INVALID, code: 'VALIDATION_ERROR' });

    fleetManager.setMaxMiners(max);
    log.info({ max }, 'Fleet capacity updated via API');
    res.json({ maxMiners: max, config: fleetManager.getConfig() });
  });
}

module.exports = { registerFleetRoutes };
