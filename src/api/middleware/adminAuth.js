/**
 * LUXXPOOL — Admin Authentication Middleware
 *
 * Single source of truth for admin token verification across all
 * admin-gated API routes (fleet, security, dashboard). Uses
 * crypto.timingSafeEqual to make the comparison constant-time and
 * close the timing oracle that the previous duplicated `!==` checks
 * exposed.
 */

const crypto = require('crypto');
const config = require('../../../config');

/**
 * Compare two strings in constant time. Returns false if either is
 * not a string, or if the two strings are different lengths or values.
 * The dummy compare on length mismatch absorbs the leak that a
 * length-based early-out would create.
 */
function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // dummy compare to keep timing flat
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function requireAdminAuth(req, res, next) {
  if (!config.api.adminToken) {
    return res.status(503).json({ error: 'Admin token not configured' });
  }
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!timingSafeEqualStrings(token, config.api.adminToken)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * Soft check used by routes that downgrade response shape for
 * non-admin callers (e.g. /api/v1/miners/active strips IPs). Returns
 * true iff the request carries the valid admin token; never sends a
 * response.
 */
function isAdminRequest(req) {
  if (!config.api.adminToken) return false;
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return timingSafeEqualStrings(token, config.api.adminToken);
}

module.exports = { requireAdminAuth, isAdminRequest, timingSafeEqualStrings };
