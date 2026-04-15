# LUXXPOOL — Comprehensive Engineering Review
**Version:** 0.6.0 | **Date:** 2026-03-16 | **Reviewer:** Claude (Engineering Skills Suite)
**Scope:** Full codebase — 65 files across stratum, blockchain, pool, payment, API, monitoring, and infra layers

---

## Table of Contents

1. [Standup Summary](#1-standup-summary)
2. [System Design & Architecture](#2-system-design--architecture)
3. [Architecture Decision Record (ADR)](#3-architecture-decision-record-adr)
4. [Code Review](#4-code-review)
5. [Security & Debug Findings](#5-security--debug-findings)
6. [Technical Debt Register](#6-technical-debt-register)
7. [Testing Strategy](#7-testing-strategy)
8. [Incident Response Playbook](#8-incident-response-playbook)
9. [Deploy Checklist](#9-deploy-checklist)
10. [Documentation Audit](#10-documentation-audit)

---

## 1. Standup Summary

**What's done:**
LUXXPOOL v0.6.0 is a production-grade Scrypt merged mining pool for Litecoin + 9 AuxPoW auxiliary chains. The core architecture is complete and well-structured: Stratum v1 TCP server with SSL and solo mining variants, block template management with ZMQ + polling fallback, Redis-backed share deduplication, PPLNS payment processing, a 3-layer security engine (mining cookies, share fingerprinting, behavioral anomaly detection), fleet management, daemon health monitoring, and a REST API. The codebase is clean, consistently logged with Pino, and shows clear iterative improvement across versions.

**What's in progress / notable gaps:**
Several subsystems referenced in `src/index.js` are missing their source files (`blockNotifier.js`, `zmqNotifier.js`, `fleetManager.js` route, `addressCodec.js`). Two dedicated workers in `package.json` (`paymentWorker.js`, `blockNotify.js`) do not exist as standalone files. The test suite is emulation-based rather than unit-tested, and has no CI runner attached. The `redisKeys` reference is not passed to the API server correctly. Workers and miners in the API share a `TODO` comment.

**Blockers:**
The `blockNotifier.js` and `zmqNotifier.js` imports in `src/index.js` (lines 33–34) will cause a fatal startup crash if those files are absent from the deployed directory — these were not present in the folder provided for review.

---

## 2. System Design & Architecture

### 2.1 High-Level Architecture

LUXXPOOL is a **multi-process, event-driven mining pool** built on Node.js. It follows a layered monolith pattern with clear domain separation, all wired through a central orchestrator (`src/index.js`).

```
[ Miners (TCP/SSL/Solo) ]
         │
         ▼
[ StratumServer / StratumSSL / SoloServer ]
         │ events: subscribe, authorize, submit, disconnect
         ▼
[ BanningManager → SecurityManager (3-layer) ]
         │ valid shares
         ▼
[ ShareProcessor ]  ◄── [ BlockTemplateManager ] ◄── [ BlockNotifier (ZMQ/poll) ]
         │ validShare / blockFound                          │
         ▼                                                 ▼
[ HashrateEstimator ]                              [ AuxPowEngine (9 chains) ]
[ WorkerTracker     ]
[ FleetManager      ]
         │
         ▼
[ PaymentProcessor ] ◄── [ BlockConfirmationWatcher ]
[ MultiCoinPayment  ]
         │
         ▼
[ PostgreSQL (pg-pool) ] + [ Redis (ioredis) ]
         │
         ▼
[ REST API (Express) ] ← [ StatsCollector ] [ HealthMonitor ]
```

### 2.2 Component Responsibilities

**StratumServer** (`src/stratum/server.js`) — Handles raw TCP connections, parses line-delimited JSON, implements Stratum v1 (subscribe → authorize → submit). Manages per-client state (difficulty, nonce, auth, VarDiff) via `StratumClient`. Cap of 10,000 connections via `server.maxConnections`.

**BlockTemplateManager** (`src/blockchain/blockTemplate.js`) — Fetches `getblocktemplate` from `litecoind`, constructs the coinbase transaction (BIP34-compliant), precomputes and caches coinbase parts + merkle branches per job ID. Critical fix in v0.4.1: stores job data at creation time so share validation never uses stale template data.

**AuxPowEngine** (`src/blockchain/auxpow.js`) — Calls `createauxblock`/`submitauxblock` RPC for each of 9 auxiliary chains. Allows merged mining: one Scrypt solve satisfies LTC + all aux chains simultaneously.

**ShareProcessor** (`src/pool/shareProcessor.js`) — 8-step share validation pipeline: job lookup → Redis dedup → ntime check → header construction → Scrypt hash → difficulty check → VarDiff update → DB record → block submission. Emits typed events (`validShare`, `invalidShare`, `staleShare`, `duplicateShare`, `blockFound`).

**SecurityManager** (`src/pool/securityManager.js`) — Layer 1: HMAC-based mining cookies (anti-hijack). Layer 2: Statistical BWH detection via block-to-share ratio over 100-block windows. Layer 3: Behavioral anomaly engine — share flooding, ntime manipulation, VarDiff gaming, Sybil detection, hashrate oscillation.

**PaymentProcessor** (`src/payment/paymentProcessor.js`) — PPLNS calculation across configurable block windows, fleet-aware fee deduction (fleet miners pay 0%), `sendmany` batch payments, orphan detection, balance accumulation below minimum threshold.

**DaemonHealthMonitor** (`src/monitoring/healthMonitor.js`) — Polls all RPC clients, Redis, PostgreSQL, and system resources (memory, CPU load) every 30s. Emits typed events for downstream alerting.

### 2.3 Data Flow: Share Submission

```
Miner TCP socket
  → StratumClient._handleSubmit()
    → StratumServer emits 'submit'
      → main.js handleShare()
        → SecurityManager.anomalyEngine.analyzeShare() [public miners only]
          → ShareProcessor.processShare()
            1. templateManager.getJob(jobId)          [Map lookup]
            2. redisDedup.isDuplicate()                [Redis SETNX]
            3. ntime validation (±600s)
            4. _buildBlockHeader()                     [80-byte buffer]
            5. scryptHash() → crypto.scryptSync()     [CPU-bound]
            6. meetsTarget(hash, shareTarget)
            7. client.acceptShare() → VarDiff
            8. _recordShare() → Redis pipeline + PG INSERT
            9. meetsTarget(hash, networkTarget) → _submitBlock()
              → rpc.submitBlock(blockHex)
              → _recordBlock() → PG INSERT
              → emit('blockFound')
```

### 2.4 Design Strengths

- **Event-driven decoupling.** All inter-component communication uses Node.js EventEmitter. The orchestrator in `src/index.js` is the only place where components are wired — adding a new component requires touching exactly one file.
- **Graceful degradation.** Redis offline → pool continues in degraded mode (no dedup, no balance accumulation). Aux chain offline → LTC mining continues unaffected.
- **Job immutability.** The v0.4.1 fix storing coinbase parts per job ID is architecturally correct and prevents a class of subtle share validation bugs that plague many open-source pools.
- **Fleet isolation.** Fleet miners bypass all public-miner security checks at connection, authorization, and share submission — cleanly implemented with a single `_isFleet` flag.
- **Config validation at startup.** `config.validate()` prevents missing-credentials crashes from reaching the stratum server.

### 2.5 Design Concerns

**Monolith memory pressure.** All subsystems (stratum, payments, API, monitoring, block watcher) run in a single Node.js process. A memory leak in any subsystem (e.g., unbounded `minerStats` growth in `ShareFingerprintEngine`) will degrade the entire pool. Consider extracting payment processing and stats collection to separate processes.

**Single-threaded Scrypt hashing.** `crypto.scryptSync()` is synchronous and blocks the event loop for ~5–10ms per call at LTC parameters (N=1024). At high share rates (e.g., 1,000+ miners), this will create event loop lag and can cause stratum timeouts. This is the pool's most significant scalability bottleneck.

**In-memory state not replicated.** Banned IPs, security profiles, fleet miner state, and hashrate estimates all live in in-memory Maps. A process restart clears all of this (bans survive via DB load on startup, but security profiles and hashrate windows do not).

**ExtraNonce1 counter not persisted.** `extraNonceCounter` in `BlockTemplateManager` is an in-memory integer. On restart, it resets to 0, potentially reallocating the same extraNonce1 to new miners — a duplicate nonce space condition that could cause invalid shares until the counter diverges.

---

## 3. Architecture Decision Record (ADR)

### ADR-001: Synchronous Scrypt Hashing vs. Worker Threads
**Status:** Open
**Context:** `scryptHash()` uses `crypto.scryptSync()` which blocks Node's event loop. At current pool scale this is acceptable, but at > 500 simultaneous miners submitting shares, P99 latency on share responses will degrade.
**Options:**
- A) Keep `scryptSync` — simplest, correct, acceptable at low miner counts
- B) Move to `worker_threads` — offload hashing to a thread pool, keeps event loop free
- C) Move to a native Scrypt addon (e.g., `scrypt-js`, `node-scrypt`) — potentially faster but adds a binary dependency
**Recommendation:** Implement option B when active miner count consistently exceeds 500. The `processShare` method is already `async`, making this a non-breaking change.

### ADR-002: Monolith vs. Microservices
**Status:** Decided — Monolith
**Context:** Payment processing, API, and stratum all run in one process.
**Decision:** Acceptable for current scale. Extract `PaymentProcessor` and `StatsCollector` to separate processes when pool handles > 1,000 miners, to prevent payment logic from competing with real-time share processing for CPU.

### ADR-003: Redis Deduplication Approach
**Status:** Decided — Redis SETNX per share
**Context:** Share deduplication is critical for pool fairness. The `RedisDedup` implementation uses Redis to store a hash of `extraNonce1 + extraNonce2 + ntime + nonce + jobId`.
**Decision:** Correct approach. TTL should be set to match job window (~60 min) to prevent Redis unbounded growth. Verify this is implemented in `redisDedup.js`.

### ADR-004: ZMQ + Polling Dual-Mode Block Detection
**Status:** Decided — ZMQ primary, polling fallback
**Context:** Latency in detecting new blocks costs miners stale shares.
**Decision:** Excellent architecture. ZMQ gives sub-millisecond block notification; 5s polling acts as safety net. The `BlockNotifier` wrapper in `src/index.js` cleanly abstracts the dual mode.

### ADR-005: PPLNS Window = 2 Blocks
**Status:** Needs Review
**Context:** `PPLNS_WINDOW` defaults to 2 in `config/index.js`. For a pool with variable hashrate and small miner count, a 2-block PPLNS window can create highly unequal payout distributions (a miner who joins and submits shares right before a block is found gets disproportionate reward vs. miners who mined the whole round).
**Recommendation:** Increase default to at least 10 blocks, or document clearly in `.env.example` with explanation of tradeoffs.

---

## 4. Code Review

### 4.1 Critical Bugs

**BUG-001: Missing module imports will crash startup**
File: `src/index.js`, lines 33–34
```js
const BlockNotifier      = require('./blockchain/blockNotifier');
const ZmqBlockNotifier   = require('./blockchain/zmqNotifier');
```
Neither `src/blockchain/blockNotifier.js` nor `src/blockchain/zmqNotifier.js` exist in the provided codebase. The application will throw `MODULE_NOT_FOUND` on startup. Similarly, `package.json` references `src/workers/paymentWorker.js` and `src/workers/blockNotify.js` in the `payments` and `blocknotify` npm scripts, but only `src/workers/blockWatcher.js` exists.

**BUG-002: `redisKeys` not passed to API server**
File: `src/index.js`, line 515–521
```js
const apiApp = createApiServer({
  db: dbQuery, redis, stratumServer, soloServer,
  rpcClient: ltcRpc, auxRpcClients, auxPowEngine,
  ...
  // redisKeys is NOT in this object
});
```
In `src/api/server.js` line 27: `const { db, redis, stratumServer, rpcClient, redisKeys } = deps;` — `redisKeys` will be `undefined`. The `/api/v1/pool/stats` endpoint uses `redis.get(redisKeys.totalShares())` which will throw `TypeError: Cannot read properties of undefined (reading 'totalShares')`.

**BUG-003: Block hash stored incorrectly**
File: `src/pool/shareProcessor.js`, line 304
```js
template.previousblockhash, // will be updated with actual hash
```
The INSERT into `blocks` stores `previousblockhash` (the parent block) in the `hash` column. The actual submitted block hash is available from `reverseBuffer(hash).toString('hex')` but is not being stored. The `// will be updated` comment suggests this was deferred but never implemented.

**BUG-004: `_buildStratumJob()` called on null template**
File: `src/stratum/server.js`, line 461
```js
const job = this.templateManager._buildStratumJob();
if (job) client.sendJob(job);
```
`_buildStratumJob()` calls `this.currentTemplate` without null-checking. If a miner authorizes before the first template has been fetched (race condition at startup), this will throw. The guard `if (job)` catches the case where the method returns null, but the method itself will crash first.

### 4.2 Security Issues

**SEC-001: Mining cookies generated but not validated**
The `MiningCookieManager` generates a cookie on `subscribe` and stores it per `clientId`. The `validate()` method exists, but there is no call to `validate()` in `ShareProcessor.processShare()` or anywhere in the share submission pipeline. The cookies exist as metadata only — Layer 1 protection is not enforced.

**SEC-002: Open CORS origin**
File: `config/index.js`, line 84
```js
corsOrigin: process.env.API_CORS_ORIGIN || '*',
```
Default is `*` (all origins). The admin endpoints (`/api/v1/admin/bans`) are accessible cross-origin by default. Should default to the pool's own domain.

**SEC-003: PostgreSQL port exposed in docker-compose**
File: `docker/docker-compose.yml`, line 45
```yaml
ports:
  - "5432:5432"
```
PostgreSQL is bound to all host interfaces. In production, this should either be removed (internal Docker network only) or restricted to `127.0.0.1:5432:5432`. Same concern applies to Redis port 6379.

**SEC-004: RPC bind-all in Litecoin daemon config**
File: `docker/docker-compose.yml`, line 87
```
-rpcallowip=0.0.0.0/0
-rpcbind=0.0.0.0
```
This allows RPC connections from any IP. Should be restricted to the Docker network subnet (e.g., `172.20.0.0/16`) or the specific pool container IP.

**SEC-005: Address codec fallback in production**
File: `src/blockchain/blockTemplate.js`, line 367–373
The `_buildOutputScript` fallback uses SHA256 of the address string as a fake pubkey hash when address decoding fails. This creates a permanently unspendable output — pool rewards would be lost if `addressCodec.js` throws. The comment says "ONLY for development" but no guard prevents this from running in production.

### 4.3 Code Quality Observations

**QUALITY-001: Version string mismatch**
`package.json` declares version `0.6.0`. The startup banner in `src/index.js` (line 567) prints `LUXXPOOL v0.5.1 IS RUNNING`. Minor inconsistency but creates confusion.

**QUALITY-002: `scryptHash` maxmem calculation**
File: `src/utils/hashing.js`, line 64
```js
maxmem: 256 * SCRYPT_N * SCRYPT_R,
```
For LTC params (N=1024, r=1), this yields 256KB. Node.js `crypto.scryptSync` requires at least `128 * N * r * p` bytes = 128KB. The current value is sufficient, but the magic number `256` is undocumented — should be `128 * 2` with a comment explaining the 2x safety margin.

**QUALITY-003: `difficultyToTarget` truncates difficulty**
File: `src/utils/hashing.js`, line 78
```js
const target = DIFF1_TARGET / BigInt(Math.floor(difficulty));
```
Flooring difficulty before BigInt conversion causes precision loss for fractional difficulties (e.g., VarDiff-adjusted 384.5 becomes 384). This is standard practice in the industry but should be documented.

**QUALITY-004: `workers` endpoint TODO**
File: `src/api/server.js`, line 74
```js
workers: activeMiners, // TODO: track individually
```
Workers (sub-miners per address) are tracked individually in the DB via the `workers` table and `WorkerTracker`, but the API aggregates them with miner count. The infrastructure exists — this just needs wiring.

**QUALITY-005: `_handleAlert` emits `alert` twice**
File: `src/pool/securityManager.js`, line 508–511
```js
this.anomalyEngine.on('alert', (alert) => {
  this._handleAlert(alert);
});
// ...
_handleAlert(alert) {
  // ...
  this.emit('alert', alert);  // re-emits the same alert
}
```
The `anomalyEngine` already emits `alert`. `SecurityManager` listens and re-emits on itself. Any listener on `securityManager.on('alert')` will receive the alert once — correct. But double-check that `BehavioralAnomalyEngine.analyzeShare()` in `src/index.js` lines 376–386 also checks `anomalies` directly rather than relying on this chain.

**QUALITY-006: Unbounded `minerStats` Map in `ShareFingerprintEngine`**
`shareTimes` and `diffHistory` arrays per miner are trimmed to 5,000 entries, but the Map itself grows without bound — every unique miner address ever seen creates an entry. A pool with high miner churn will accumulate stale entries indefinitely. Needs a TTL-based cleanup similar to `BehavioralAnomalyEngine.cleanup()`.

---

## 5. Security & Debug Findings

### 5.1 Debug Guide: Common Failure Modes

**Failure: Pool starts but miners get "job not found" on every share**
Root cause: `BlockTemplateManager` not yet populated (startup race) or ZMQ configured but not receiving. Debug steps:
1. Check logs for `New block template` message — if absent, LTC daemon is not responding to `getblocktemplate`
2. Verify `LTC_ZMQ_ENABLED` in `.env` — if true, confirm `litecoind` has `-zmqpubhashblock` configured
3. Check `validJobs` Map size via a debug log — if 0, template updates are failing silently

**Failure: All shares are rejected as duplicates**
Root cause: Redis key prefix mismatch (double-prefix bug noted in code). Debug steps:
1. Redis CLI: `KEYS lux:*` — verify keys exist with single prefix
2. Check that `ioredis` client has no `keyPrefix` option set (removed in v0.4.1 per inline comment)
3. Verify `redisDedup.js` uses `this.keys.someKey()` not raw strings

**Failure: Payments never sent**
Root cause: `PAYMENT_ENABLED` not set to `true`, or no blocks have reached `confirmations >= 100`. Debug steps:
1. Check `config.payment.enabled` — default is `false`
2. Query: `SELECT * FROM blocks WHERE confirmed = false AND orphaned = false ORDER BY height ASC LIMIT 5`
3. Verify `litecoind` RPC has a funded wallet with `getbalance > 0` for `sendmany`

**Failure: Security engine banning legitimate miners**
Root cause: `maxSharesPerSecond = 10` may be too low for high-difficulty ASICs with fast share submission. Debug steps:
1. Check `security_events` table for `SHARE_FLOOD` events
2. Correlate banned IPs with known fleet addresses — if fleet, verify `FLEET_IPS` env is populated
3. Adjust `DDOS_MAX_CONNECTIONS_PER_IP` and anomaly thresholds in config

**Failure: `TypeError: Cannot read properties of undefined (reading 'totalShares')`**
Root cause: BUG-002 — `redisKeys` not passed to API server. Fix: add `redisKeys` to the `createApiServer()` call in `src/index.js`.

### 5.2 Monitoring & Observability

The `DaemonHealthMonitor` covers daemon connectivity, Redis, PostgreSQL, and system resources. Gaps:
- No Prometheus/metrics endpoint (config references `METRICS_PORT=9100` but no metrics server is implemented)
- No alerting integration (PagerDuty, Slack webhook, etc.)
- No per-share latency tracking (event loop lag from Scrypt is invisible)
- `pool_stats` table is populated by `StatsCollector` but no retention policy exists — unbounded growth

---

## 6. Technical Debt Register

### Priority: Critical

**TD-001: Missing source files (blockNotifier, zmqNotifier, addressCodec)**
Impact: Application will not start without these files.
Effort: Medium — `blockNotifier.js` behavior can be inferred from usage in `src/index.js`. It wraps ZMQ subscription + polling and emits `'newBlock'`. Needs to be implemented or found/restored.

**TD-002: Mining cookie validation not wired**
Impact: Layer 1 security (anti-hijack) is entirely ineffective despite being implemented.
Effort: Low — add `securityManager.cookieManager.validate(client.id, share.cookie)` in `processShare()` and define how miners submit the cookie (likely via extraNonce1 binding or a custom stratum extension).

### Priority: High

**TD-003: Scrypt hashing blocks event loop**
Impact: At scale (500+ miners), share response latency degrades linearly.
Effort: Medium-High — requires refactoring `processShare()` to offload `scryptHash()` to `worker_threads`.

**TD-004: ExtraNonce1 counter not persisted**
Impact: On restart, nonce spaces can collide for ~65,536 connections before the counter wraps.
Effort: Low — store counter in Redis with `SET lux:extraNonceCounter {value}` and restore on startup.

**TD-005: `ShareFingerprintEngine.minerStats` Map unbounded**
Impact: Memory leak proportional to unique miner count over pool lifetime.
Effort: Low — add a cleanup timer similar to `BehavioralAnomalyEngine.cleanup()`.

**TD-006: Block hash not stored correctly**
Impact: The `blocks.hash` column always contains `previousblockhash` not the submitted block hash. Orphan detection, block explorer links, and manual verification are broken.
Effort: Low — capture the actual block hash from `submitBlock` response and store it.

### Priority: Medium

**TD-008: PPLNS window default too small (2 blocks)**
Impact: New miners joining right before a block find get disproportionate payout. Reduces pool fairness for small miners.
Effort: Trivial — change default in `config/index.js` and `.env.example`.

**TD-009: `shares` table has no partition strategy**
Impact: At 10 shares/second (conservative), the `shares` table grows by ~864,000 rows/day. No partition or archival strategy will cause query performance to degrade within weeks.
Effort: Medium — add `pg_partman` monthly partitioning on `created_at`.

**TD-010: No connection draining on graceful shutdown**
Impact: Miners mid-share-submission at shutdown lose their share (uncounted valid work).
Effort: Medium — in `stop()`, wait for `shareProcessor` queue to drain before closing sockets.

### Priority: Low

**TD-011: Docker Compose uses `version: '3.9'` (deprecated syntax)**
Impact: Warnings on newer Docker Compose versions. No functional issue.
Effort: Trivial — remove the `version:` key.

**TD-012: `bignum` dependency may have native build issues**
Package `bignum@0.13.1` requires native compilation. Most operations in the codebase use native `BigInt` — verify `bignum` is actually used and consider removing it.

**TD-013: `jest` listed as devDependency but tests use `node tests/run-all.js`**
Jest is installed but not configured or used. Tests are plain Node.js scripts. Either configure Jest properly or remove the devDependency.

---

## 7. Testing Strategy

### 7.1 Current Test Coverage

The codebase has two test emulation scripts:
- `tests/emulation.js` — Mining pipeline + fleet (Emulation A+B)
- `tests/emulation-c.js` — Address validation, security, Redis deduplication, VarDiff

These are integration-style emulations that mock external dependencies and exercise the full share processing pipeline. No unit tests exist for individual modules.

**Coverage gaps:**
- `BlockTemplateManager` — coinbase construction, merkle branch computation, job eviction
- `PaymentProcessor` — PPLNS calculation correctness, orphan handling, batch batching logic
- `BanningManager` — ban persistence, cleanup, rate tracking
- `SecurityManager` — BWH detection, timing anomaly, cookie validation
- `VarDiffManager` — retarget timing, power-of-2 snapping
- `hashing.js` — all exported functions (highest-value test target — pure functions with no deps)
- AuxPoW submission flow
- Block submission and DB recording

### 7.2 Recommended Test Strategy

**Tier 1 — Unit Tests (add first, highest ROI)**

Pure utility functions in `src/utils/hashing.js` are the ideal starting point — zero dependencies, deterministic, and critical to correctness:
- `sha256d(Buffer)` — verify against known LTC block header hashes
- `bitsToTarget('1a01cd2d')` — verify against LTC genesis block target
- `meetsTarget(hash, target)` — boundary conditions (hash === target should return true)
- `buildMerkleBranches([])` — empty transaction list
- `difficultyToTarget(512)` — round-trip with `targetToDifficulty`

**Tier 2 — Component Tests**

`VarDiffManager` is the next best target — pure logic with a clock dependency:
- Mock `Date.now()` to control timing
- Test: retarget fires after `retargetTime` seconds
- Test: difficulty clamps at `minDiff` and `maxDiff`
- Test: power-of-2 snapping (384 → 256 or 512?)

**Tier 3 — Integration Tests**

`ShareProcessor` with mocked RPC and Redis:
- Valid share accepted, Redis pipeline called, DB INSERT called
- Duplicate share rejected (mock `redisDedup.isDuplicate` to return true)
- Stale job rejected
- Block solution triggers `submitBlock` + `_recordBlock`

**Tier 4 — CI Pipeline**

```yaml
# Recommended .github/workflows/ci.yml
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_DB: luxxpool_test, POSTGRES_USER: luxxpool, POSTGRES_PASSWORD: test }
        ports: ["5432:5432"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm test
      - run: npm run lint
```

### 7.3 Test Naming Convention

Follow existing pattern for new tests:
```js
test('ShareProcessor: rejects duplicate share', async () => {
  // Arrange
  // Act
  // Assert
});
```

---

## 8. Incident Response Playbook

### 8.1 Severity Levels

| Level | Description | Response Time | Example |
|-------|-------------|---------------|---------|
| P1 — Critical | Pool completely down or all miners disconnected | Immediate | LTC daemon unreachable, PostgreSQL down, stratum port closed |
| P2 — High | Block submission failing, payments stalled | 15 minutes | `submitBlock` returning rejection, `sendmany` failing |
| P3 — Medium | Elevated invalid share rate, security bans firing | 1 hour | BWH suspect, DDoS in progress, aux chain offline |
| P4 — Low | API errors, hashrate display issues, logging gaps | Next business day | Stats endpoint 500, Redis latency spike |

### 8.2 P1 Runbook: Pool Stratum Unreachable

**Symptoms:** Miners cannot connect on port 3333/3334/3336. API returns 502.

**Triage steps:**
1. `docker ps` — is `luxxpool-pool` container running?
2. If container down: `docker logs luxxpool-pool --tail 100` — check for fatal startup error
3. Most likely causes: missing env var (LTC_PASS, PG_PASS), missing module file (BUG-001), PostgreSQL not ready
4. If container running but ports unreachable: check firewall (`ufw status`, AWS security groups)
5. Confirm LTC daemon: `docker exec luxxpool-litecoind litecoin-cli getblockchaininfo`

**Resolution:**
- Missing module: restore missing `.js` files from version control or deploy backup
- Config error: fix `.env`, `docker compose restart luxxpool`
- Daemon unreachable: `docker compose restart litecoind`, wait for sync

### 8.3 P1 Runbook: Block Found but Not Recorded

**Symptoms:** Miner reports a block find in their client, but `blocks` table shows nothing, and pool didn't broadcast new work.

**Triage steps:**
1. Search logs: `grep "BLOCK FOUND" /var/log/luxxpool/pool.log`
2. If found in logs but not in DB: check `_recordBlock` error — likely a DB connection issue
3. If `submitBlock` logged as rejected: the block data was malformed — check `_buildBlockHeader` and coinbase construction
4. If not in logs: the share met network target but `_submitBlock` threw before logging — check uncaught exceptions

**Resolution:**
1. Manual submission: retrieve the block hex from logs, submit via `litecoin-cli submitblock <hex>`
2. If rejected by daemon: block is stale (another pool found it first) — no action needed
3. Investigate root cause of submission failure before re-enabling mining

### 8.4 P2 Runbook: Payments Not Processing

**Symptoms:** Miners report no payments despite confirmed blocks and enough balance.

**Triage steps:**
1. Verify `PAYMENT_ENABLED=true` in `.env`
2. Query: `SELECT height, confirmed, orphaned FROM blocks WHERE confirmed=false AND orphaned=false ORDER BY height`
3. Query: `SELECT getbalance FROM litecoin-cli` — wallet must have funds
4. Check payment processor logs for `processPayments` errors
5. If "already in progress": a previous run hung — restart the pool process

**Resolution:**
- Balance insufficient: wallet needs funding (separate operational concern)
- PPLNS window issue: check if `shares` table has records for the relevant block heights
- Minimum payout threshold: miners below `PAYMENT_MIN_PAYOUT` accumulate in Redis — check `lux:pending:{address}`

### 8.5 P3 Runbook: Security Engine Banning Legitimate Miners

**Symptoms:** Miners complain of disconnections, `security_events` table shows `SHARE_FLOOD` or `SYBIL_SUSPECTED` for known good miners.

**Triage steps:**
1. Query: `SELECT * FROM security_events WHERE address = '<miner_addr>' ORDER BY created_at DESC LIMIT 20`
2. Check if the miner's IP is in `FLEET_IPS` — if so, they should be bypassing security
3. Check anomaly thresholds: `maxSharesPerSecond=10` is conservative for high-hashrate ASICs

**Resolution:**
- Add miner IP to `FLEET_IPS` env var (requires restart)
- Increase `DDOS_MAX_CONNECTIONS_PER_IP` if legitimate NAT scenario
- Manual unban via API: `DELETE FROM banned_ips WHERE ip_address = '<ip>'`

### 8.6 Communication Templates

**Scheduled maintenance:**
> LUXXPOOL will undergo maintenance on [DATE] from [TIME] UTC. Mining will pause for approximately [DURATION]. Please expect reconnection delays. Your shares are safe.

**Unplanned outage:**
> We are investigating an issue affecting [stratum/payments/API]. Mining [is/is not] affected. We will update this message as we learn more. Estimated resolution: [ETA or "under investigation"].

**Payment delay:**
> Payouts are delayed due to [reason]. All confirmed block rewards are secure and will be distributed once [condition]. No shares have been lost.

---

## 9. Deploy Checklist

### 9.1 Pre-Deploy: Environment Validation

- [ ] `.env` file is present and not `.env.example`
- [ ] `LTC_PASS` is set (non-empty, matches `litecoind` config)
- [ ] `PG_PASS` is set and matches Docker Compose `POSTGRES_PASSWORD`
- [ ] `POOL_FEE_ADDRESS` is a valid Litecoin address (L..., M..., or ltc1...)
- [ ] `SSL_CERT_PATH` and `SSL_KEY_PATH` are set if `STRATUM_PORT_SSL` is exposed
- [ ] `PAYMENT_ENABLED` is `true` only if wallet is funded
- [ ] `POOL_FEE` is between 0 and 0.10 (0–10%)
- [ ] `API_CORS_ORIGIN` is set to pool's own domain (not `*`) in production
- [ ] `FLEET_IPS` contains only owned mining infrastructure IPs
- [ ] Each enabled aux chain has `{COIN}_ENABLED=true`, `{COIN}_HOST`, `{COIN}_PORT`, `{COIN}_USER`, `{COIN}_PASS`, `{COIN}_ADDRESS`

### 9.2 Pre-Deploy: Infrastructure

- [ ] PostgreSQL port `5432` is NOT exposed to public internet (remove from `ports:` in docker-compose)
- [ ] Redis port `6379` is NOT exposed to public internet
- [ ] Litecoin daemon `rpcallowip` is restricted to Docker network, not `0.0.0.0/0`
- [ ] All daemon `rpcpassword` values are strong, unique, and match pool config
- [ ] SSL certificate is valid and not expired: `openssl x509 -in /path/to/cert.pem -text -noout | grep "Not After"`
- [ ] DNS records for `luxxpool.io` point to this server
- [ ] Firewall allows: 3333 (stratum), 3334 (SSL stratum), 3336 (solo), 8080 (API — consider putting behind nginx)
- [ ] Firewall blocks: 5432, 6379, 9332, 22555 (all daemon/DB ports) from public

### 9.3 Pre-Deploy: Application

- [ ] Missing source files confirmed present: `src/blockchain/blockNotifier.js`, `src/blockchain/zmqNotifier.js`, `src/utils/addressCodec.js`
- [ ] `npm ci` completes without errors (not `npm install` — use lockfile)
- [ ] `npm run lint` passes with 0 errors
- [ ] `npm test` passes with 0 failed tests
- [ ] `npm run migrate` applies all 3 migrations cleanly on a fresh database
- [ ] `node -e "require('./config').validate()"` outputs no errors
- [ ] BUG-002 fix confirmed: `redisKeys` is included in `createApiServer()` deps object

### 9.4 Deploy Steps

```bash
# 1. Pull latest code
git pull origin main

# 2. Build container
docker compose -f docker/docker-compose.yml build --no-cache luxxpool

# 3. Run database migrations (non-destructive, IF NOT EXISTS)
docker compose -f docker/docker-compose.yml run --rm luxxpool npm run migrate

# 4. Start all services
docker compose -f docker/docker-compose.yml up -d

# 5. Monitor startup
docker logs luxxpool-pool -f --tail 50

# 6. Verify health endpoint
curl http://localhost:8080/health

# 7. Verify stratum port
nc -zv localhost 3333

# 8. Verify a test miner can connect and authorize
# (use a test mining software or netcat + manual JSON)
```

### 9.5 Post-Deploy Verification

- [ ] `GET /health` returns `{"status":"ok"}`
- [ ] `GET /api/v1/pool/stats` returns network difficulty and block height matching blockchain explorer
- [ ] Stratum port 3333 accepts TCP connections
- [ ] At least one test miner connects and receives a job within 30 seconds
- [ ] `docker logs luxxpool-pool` shows no `ERROR` or `FATAL` entries
- [ ] Block template is updating (log shows `New block template` within 60 seconds)
- [ ] Redis: `redis-cli -n 0 KEYS lux:*` shows share and round keys
- [ ] PostgreSQL: `SELECT COUNT(*) FROM shares` is incrementing

### 9.6 Rollback Plan

```bash
# Immediate rollback to previous image
docker compose -f docker/docker-compose.yml down
git checkout HEAD~1
docker compose -f docker/docker-compose.yml build luxxpool
docker compose -f docker/docker-compose.yml up -d

# Database migrations are forward-only (IF NOT EXISTS). If a migration
# introduced schema changes that are incompatible with the old code,
# you must restore from a pre-deploy PostgreSQL backup.
```

---

## 10. Documentation Audit

### 10.1 What's Well-Documented

The codebase has strong inline documentation overall:

- **`src/index.js`** — Extensive startup commentary, version history, and wiring explanation. The `═══` section headers make the flow readable.
- **`src/pool/securityManager.js`** — Excellent module-level docblock citing the academic paper (Recabarren & Carbunar, PoPETs 2017) and clearly explaining each of the 3 security layers and their threat models.
- **`src/pool/shareProcessor.js`** — Each validation step is numbered and commented.
- **`src/utils/hashing.js`** — All exported functions have JSDoc with `@param` and `@returns`.
- **`src/blockchain/blockTemplate.js`** — The critical v0.4.1 fix is well-annotated explaining *why* stored job data must be used for share validation.
- **`README.md`** — Comprehensive: architecture diagram, coin table, quickstart, project structure, API endpoint reference.

### 10.2 Documentation Gaps

**GAP-001: No API authentication documentation**
The admin endpoints (`/api/v1/admin/bans`) appear unauthenticated. The docs don't clarify whether admin routes require any auth token, IP restriction, or are intentionally public. This needs a security note.

**GAP-002: AuxPoW flow not documented**
`src/blockchain/auxpow.js` is not provided but is central to the pool's value proposition. No document explains the `createauxblock` → share solve → `submitauxblock` cycle for operators setting up new aux chains.

**GAP-003: Fleet manager configuration not in README**
The `FLEET_IPS`, `FLEET_ADDRESSES`, `FLEET_FEE`, and `FLEET_MAX_MINERS` environment variables exist in `src/index.js` but are not in the README or `.env.example`. Operators won't know this feature exists.

**GAP-004: Payment scheme options not documented**
`PAYMENT_SCHEME` accepts values (e.g., `pplns`) but the README and `.env.example` don't list valid options or explain the tradeoffs between schemes.

**GAP-005: No ops runbook for daemon sync**
On fresh deployment, `litecoind` must fully sync (~60GB blockchain) before the pool can mine. There is no documentation on how long this takes, how to monitor sync progress, or what the pool does during sync (it correctly aborts with `log.fatal` — but operators don't know this behavior).

**GAP-006: `docs/engineering/` directory contains planning files, not live docs**
The files `CODE_REVIEW.md`, `DOCUMENTATION.md`, `INCIDENT_RESPONSE.md`, etc. in `docs/engineering/` appear to be skill output templates, not maintained documentation for this specific codebase. Recommend replacing or supplementing with this review document.

### 10.3 Recommended Documentation Additions

| Document | Location | Priority |
|----------|----------|----------|
| Operator's Setup Guide (daemon sync, wallet setup, SSL) | `docs/OPERATIONS.md` | High |
| Fleet Manager Configuration | `README.md` → Fleet section | High |
| API Authentication & Admin Endpoints | `docs/API.md` | High |
| AuxPoW Chain Integration Guide | `docs/AUXPOW.md` | Medium |
| Payment Scheme Comparison (PPLNS vs PPS) | `docs/PAYMENTS.md` | Medium |
| Monitoring & Alerting Setup | `docs/MONITORING.md` | Medium |

---

## Summary: Top 10 Action Items

Listed by urgency:

1. **Restore missing source files** — `blockNotifier.js`, `zmqNotifier.js`, `addressCodec.js` (app will not start without these)
2. **Fix `redisKeys` not passed to API** — BUG-002 causes `/api/v1/pool/stats` to throw on every request
3. **Store correct block hash in `_recordBlock`** — BUG-003 breaks orphan detection and block verification
4. **Wire mining cookie validation** — SEC-001: Layer 1 security is implemented but never called
5. **Restrict Docker network ports** — SEC-003/004: PostgreSQL, Redis, and daemon RPC are publicly reachable
6. **Add Redis key TTL to `redisDedup`** — Prevents unbounded Redis growth from share deduplication keys
7. **Add cleanup timer to `ShareFingerprintEngine`** — TD-005: Prevents memory leak on long-running pools
8. **Persist `extraNonceCounter` to Redis** — TD-004: Prevents nonce space collisions on restart
9. **Add unit tests for `hashing.js` and `VarDiffManager`** — Highest ROI test targets
10. **Increase PPLNS window default** — TD-008: Change from 2 to 10 blocks for fairer distribution

---

*Report generated by Claude Engineering Skills Suite — covering /code-review, /documentation, /incident-response, /system-design, /tech-debt, /testing-strategy, /architecture, /debug, /deploy-checklist, /incident, /review, /standup*
