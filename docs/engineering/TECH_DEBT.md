# LUXXPOOL v0.6.0 — Tech Debt Registry

Generated: 2025-03-16
Codebase: 60 files, 8,652 lines, 35 source modules

## Critical (fix before production)

### TD-001: Orphaned banner.js
- **Location:** `src/stratum/banner.js` (10 lines)
- **Issue:** Import removed in v0.6.0 but file still exists on disk. Dead code.
- **Resolution:** Delete the file.
- **Effort:** 1 minute

### TD-002: Duplicate ZMQ implementations
- **Location:** `src/blockchain/blockNotifier.js` (148 lines), `src/blockchain/zmqNotifier.js` (127 lines), `src/blockchain/blockTemplate.js` (inline ZMQ, 40 lines)
- **Issue:** Three separate ZMQ implementations. blockTemplate.js has inline ZMQ added in v0.6.0. blockNotifier.js and zmqNotifier.js are standalone classes from earlier builds, imported nowhere.
- **Resolution:** Keep the inline ZMQ in blockTemplate.js (it's the wired one). Delete blockNotifier.js and zmqNotifier.js.
- **Effort:** 5 minutes

### TD-003: Empty catch blocks (10 locations)
- **Locations:** blockTemplate.js:117, blockNotifier.js:61, zmqNotifier.js:112, index.js:548-549, statsCollector.js:49, workerTracker.js:198+213, multiCoinPayment.js:239+256
- **Issue:** `catch {}` silently swallows errors. Acceptable for shutdown cleanup (index.js), problematic for operational code (workerTracker, multiCoinPayment, statsCollector).
- **Resolution:** Add `catch (err) { log.debug({ err: err.message }, 'context') }` to operational catch blocks. Keep shutdown catch-alls.
- **Effort:** 15 minutes

### TD-004: API route input validation missing
- **Location:** `src/api/routes/extended.js` lines 53, 101-102, 129, 165; `src/api/routes/fleet.js` lines 36, 52
- **Issue:** `req.params.coin.toUpperCase()` crashes if coin is undefined. `req.body.coin` used without validation. Fleet IP from req.body passed directly to whitelist.
- **Resolution:** Add input validation middleware or inline checks. Sanitize IP addresses before fleet operations.
- **Effort:** 30 minutes

## High (fix in next sprint)

### TD-005: Hardcoded time constants
- **Locations:** securityManager.js:181 (`86400`), :266 (`3600000`), :420 (`3600000`), server.js:106 (`600000`)
- **Issue:** Magic numbers for time durations scattered across files. Should be named constants or config values.
- **Resolution:** Extract to config or module-level constants with descriptive names.
- **Effort:** 20 minutes

### TD-006: Map/Set memory growth without bounds
- **Locations:** 15 Maps across banningManager, securityManager, hashrateEstimator, workerTracker, fleetManager
- **Issue:** Maps grow unbounded over time. banningManager has cleanup intervals, but hashrateEstimator.shareRecords, securityManager.minerStats, and securityManager.profiles do not have explicit size caps.
- **Resolution:** Add maxSize config to each Map. Implement LRU eviction or periodic cleanup based on last-activity timestamp.
- **Effort:** 2 hours

### TD-007: TODO in API server
- **Location:** `src/api/server.js:74` — `workers: activeMiners, // TODO: track individually`
- **Issue:** Worker count uses miner count instead of actual distinct worker connections.
- **Resolution:** Use workerTracker.getActiveWorkers() now that it's wired.
- **Effort:** 10 minutes

## Medium (fix when convenient)

### TD-008: Object.assign on fleet updates
- **Location:** `src/pool/fleetManager.js:294-298`
- **Issue:** `Object.assign(fleet, updates)` could introduce unexpected properties if caller passes arbitrary object.
- **Resolution:** Whitelist allowed update keys: `{ hashrate, validShares, invalidShares, lastShareTime }`.
- **Effort:** 10 minutes

### TD-009: Unchecked array access [0]
- **Locations:** api/server.js:191, hashrateEstimator.js:163, multiCoinPayment.js:193
- **Issue:** `rows[0].count` without checking `rows.length > 0` first.
- **Resolution:** Add `if (!rows.length)` guards.
- **Effort:** 10 minutes

### TD-010: Test file version label
- **Location:** `tests/emulation.js` line 1 — still says "v0.5.2"
- **Issue:** Cosmetic. Test header doesn't match package version.
- **Resolution:** Update to "v0.6.0".
- **Effort:** 1 minute

## Summary

| Severity | Count | Est. Effort |
|----------|-------|-------------|
| Critical | 4     | ~50 min     |
| High     | 3     | ~2.5 hours  |
| Medium   | 3     | ~20 min     |
| **Total**| **10**| **~3.5 hours** |
