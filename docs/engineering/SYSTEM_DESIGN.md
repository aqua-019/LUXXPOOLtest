# LUXXPOOL v0.6.0 — System Design

## Architecture Overview

```
                    ┌──────────────────┐
                    │   ASIC Miners    │
                    │  (Antminer L9)   │
                    └────────┬─────────┘
                             │ Stratum v1 (TCP/SSL)
                    ┌────────▼─────────┐
                    │  Stratum Server  │ :3333 pool / :3334 ssl / :3336 solo
                    │  (server.js)     │
                    └────────┬─────────┘
                             │ Events: subscribe, authorize, submit
                    ┌────────▼─────────┐
                    │  Orchestrator    │
                    │  (index.js)      │──── Fleet Manager ──── 0% fee, bypass security
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼───────┐ ┌───▼──────┐ ┌────▼─────────┐
     │ Security Engine │ │  Share   │ │  Block       │
     │ (3 layers)      │ │Processor │ │  Template    │
     │ L1: Cookies     │ │          │ │  Manager     │
     │ L2: Fingerprint │ │ Redis    │ │  ZMQ + Poll  │
     │ L3: Anomaly     │ │ dedup    │ │              │
     └────────┬────────┘ └───┬──────┘ └──────┬───────┘
              │              │               │
              │    ┌─────────▼────────┐      │
              │    │    PostgreSQL    │      │
              │    │  shares, blocks  │      │
              │    │  payments, bans  │      │
              │    └─────────┬────────┘      │
              │              │               │
     ┌────────▼───────┐ ┌───▼──────┐ ┌──────▼───────┐
     │  Banning Mgr   │ │ Payment  │ │  AuxPoW      │
     │  IP tracking   │ │Processor │ │  Engine      │
     │  Auto-escalate │ │ PPLNS    │ │  9 chains    │
     └────────────────┘ └──────────┘ └──────────────┘
              │                              │
     ┌────────▼───────┐              ┌──────▼───────┐
     │     Redis      │              │   Litecoin   │
     │ shares, dedup  │              │   Core RPC   │
     │ balances, rate │              │   + ZMQ      │
     └────────────────┘              └──────────────┘
```

## Component Registry

| Component | File | Lines | Role | Dependencies |
|-----------|------|-------|------|--------------|
| Orchestrator | index.js | 588 | Wires all components, manages lifecycle | All |
| Stratum Server | stratum/server.js | 541 | TCP socket server, stratum protocol | VarDiff, UX Copy |
| SSL Server | stratum/ssl.js | 82 | TLS wrapper around stratum | server.js, certs |
| Solo Server | stratum/solo.js | 151 | Solo mining variant | server.js |
| VarDiff | stratum/vardiff.js | 101 | Adaptive difficulty | None |
| Block Template | blockchain/blockTemplate.js | 435 | Job construction, coinbase, merkle | RPC, hashing |
| AuxPoW Engine | blockchain/auxpow.js | 455 | Merged mining for 9 chains | RPC per chain |
| RPC Client | blockchain/rpcClient.js | 186 | Litecoin Core JSON-RPC | HTTP |
| Share Processor | pool/shareProcessor.js | 318 | Validate shares, record to DB/Redis | Template, RPC, Redis |
| Security Manager | pool/securityManager.js | 548 | 3-layer security engine | Banning |
| Banning Manager | pool/banningManager.js | 348 | IP bans, rate limiting | DB |
| Fleet Manager | pool/fleetManager.js | 398 | LUXX miner whitelist | None |
| Redis Dedup | pool/redisDedup.js | 47 | Share deduplication | Redis |
| Payment Processor | payment/paymentProcessor.js | 313 | PPLNS payouts | RPC, DB, Redis |
| Multi-Coin Payment | payment/multiCoinPayment.js | 260 | Aux chain payouts | RPC per chain, DB |
| Stats Collector | monitoring/statsCollector.js | 101 | Periodic stats snapshots | DB, Redis |
| Hashrate Estimator | monitoring/hashrateEstimator.js | 194 | Per-worker hashrate calc | None |
| Worker Tracker | monitoring/workerTracker.js | 218 | Worker lifecycle tracking | DB, Redis |
| Health Monitor | monitoring/healthMonitor.js | 155 | Daemon/DB/Redis health | All RPC, Redis, DB |
| Block Watcher | workers/blockWatcher.js | 178 | Confirmation tracking | RPC, DB |
| API Server | api/server.js | 292 | REST API + routes | Express, all managers |
| Address Codec | utils/addressCodec.js | 257 | LTC address validation | None (pure) |
| Hashing | utils/hashing.js | 279 | Scrypt, SHA256d, merkle | crypto (stdlib) |
| Redis Keys | utils/redisKeys.js | 51 | Centralized key builder | None (pure) |
| UX Copy | ux/copy.js | 410 | All user-facing strings | None (pure) |

## Data Flow: Share Submission

```
Miner → TCP socket → Stratum.on('submit')
  → Fleet check (bypass security if fleet)
  → Security L1: Cookie verification
  → Security L2: Share fingerprinting
  → Security L3: Anomaly detection
  → ShareProcessor.processShare()
    → Redis dedup check
    → Rebuild coinbase from stored job data (NOT current template)
    → Compute merkle root
    → Build 80-byte header
    → Scrypt hash (N=1024, r=1, p=1)
    → Compare hash vs share difficulty target
    → Compare hash vs network difficulty target (block found?)
    → Emit 'validShare' / 'invalidShare' / 'blockFound'
  → validShare → Redis pipeline (round shares, worker shares, last share)
  → validShare → HashrateEstimator.recordShare()
  → validShare → WorkerTracker.onValidShare()
  → blockFound → RPC submitblock()
  → blockFound → AuxPoW check all aux chains
  → blockFound → Force template update
```

## Scaling Limits (Current Architecture)

| Dimension | Current | Limit | Bottleneck |
|-----------|---------|-------|------------|
| Miners | 22 | ~500 | Single Node.js event loop |
| Hashrate | 327 GH/s | ~5 TH/s | Scrypt validation CPU |
| Shares/sec | ~3 | ~200 | Redis pipeline throughput |
| Aux chains | 7 active | 9 max | RPC call latency |
| Block templates | 1s poll | Instant | ZMQ (now implemented) |

## Scaling Path (defined in prior sessions)

1. **Bootstrap** (current): Single server, 20 L9s, 22 miners total
2. **Growth** (100-500 miners): Add Redis cluster, read replicas for DB
3. **Enterprise** (500-2000): Multiple stratum workers behind load balancer
4. **Titan** (2000+): Kubernetes, custom Rust stratum, sharded share processing
