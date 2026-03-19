# LUXXPOOL v0.6.0 — Code Review

Generated: 2025-03-16
Reviewer: Automated engineering audit
Scope: 35 source modules, 8,652 lines

## Architecture Assessment

**Strengths:**
- Clean separation of concerns (stratum / blockchain / pool / payment / monitoring)
- EventEmitter-based decoupling — share results flow through events, not direct calls
- Fleet management properly isolated from security pipeline
- No circular dependencies detected
- Single orchestrator (index.js) wires everything — clear dependency graph
- UX copy system centralizes all user-facing strings

**Weaknesses:**
- index.js at 588 lines is approaching orchestrator bloat (threshold: 400)
- 3 duplicate ZMQ implementations (blockTemplate inline, blockNotifier, zmqNotifier)
- Missing input validation layer on API routes
- No request rate limiting at application level (relies entirely on Nginx)

## Security Findings

### SEC-001: API Parameter Injection (HIGH)
```
src/api/routes/extended.js:53
  const coin = req.params.coin.toUpperCase();
```
If `coin` is not in the SCRYPT_COINS whitelist, this proceeds to a DB query with user-controlled input. The `toUpperCase()` itself can crash on undefined.

**Remediation:** Validate `coin` against known symbols before use. Return 400 for unknown coins.

### SEC-002: Fleet IP Addition Without Auth (HIGH)
```
src/api/routes/fleet.js:52
  const { ip } = req.body;
  fleetManager.addIp(ip);
```
The fleet API accepts any IP address from the request body. While Nginx restricts this to localhost/VPN, the application has no auth layer. A compromised adjacent service could whitelist attacker IPs.

**Remediation:** Add bearer token or HMAC authentication to fleet management endpoints.

### SEC-003: Object.assign Prototype Risk (MEDIUM)
```
src/pool/fleetManager.js:294
  Object.assign(fleet, updates);
```
If `updates` contains `__proto__` or `constructor` keys, this enables prototype pollution.

**Remediation:** Use explicit property assignment or `pick()` utility.

### SEC-004: No CORS Origin Validation (LOW)
API server sets no CORS headers at application level — relies on Nginx. If API is ever exposed directly (debugging, misconfiguration), any origin can make requests.

**Remediation:** Add `cors` middleware with whitelist in api/server.js as defense-in-depth.

## Code Quality

### Pattern: Error Handling
- **Good:** All RPC calls wrapped in try/catch with structured logging
- **Good:** Share processor emits distinct events for valid/invalid/stale/duplicate
- **Bad:** 10 empty `catch {}` blocks in operational code
- **Bad:** `process.on('uncaughtException')` logs but still exits — should attempt graceful shutdown first

### Pattern: Memory Management
- **Good:** validJobs Map capped at maxJobs=10 (blockTemplate.js)
- **Good:** banningManager has periodic cleanup for expired bans
- **Bad:** hashrateEstimator.shareRecords grows unbounded for long-lived miners
- **Bad:** securityManager.minerStats and .profiles have no eviction
- **Recommendation:** Implement `maxEntries` on all Maps with LRU or time-based eviction

### Pattern: Concurrency
- **Good:** Redis `pipeline` used for atomic multi-operation share recording
- **Good:** Redis `incrbyfloat` for atomic balance updates
- **Good:** Payment processor uses a `this.processing` lock
- **Neutral:** No distributed locking (acceptable for single-instance deployment)
- **Risk:** If scaled to multi-instance, share dedup and payment locks need Redis-based distributed locks (REDLOCK)

### Pattern: Logging
- **Good:** Structured logging with pino throughout (createLogger per module)
- **Good:** No `console.log` calls found anywhere
- **Good:** UX copy system prevents log messages from leaking to miners

## Recommendations (Priority Order)

1. Delete orphaned files (banner.js, blockNotifier.js, zmqNotifier.js)
2. Add input validation to all API routes (15 endpoints)
3. Add auth to fleet management API
4. Fix empty catch blocks in operational code
5. Cap all Maps with eviction policies
6. Extract index.js event wiring into a separate `wiring.js` module
7. Add CORS middleware as defense-in-depth
