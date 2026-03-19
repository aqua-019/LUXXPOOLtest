# LUXXPOOL v0.5.0 — Codebase Audit, Deployment Guide & Architecture

## Emulation Result: 45/45 PASSED

The full mining pipeline has been validated computationally. The critical
proof: the pool reconstructs the **exact same 80-byte block header** the
miner computes, producing identical Scrypt hashes. Share validation works.

---

## Complexity Audit

### Files at Correct Size (no changes needed)
| File | Lines | Verdict |
|---|---|---|
| redisDedup.js | 59 | Minimal, correct |
| profitEstimator.js | 87 | Static utility, clean |
| vardiff.js | 101 | Single-purpose, clear |
| statsCollector.js | 101 | Does one thing well |
| ssl.js | 82 | Thin wrapper, correct |
| solo.js | 151 | Clean fork of main stratum |
| logger.js | 31 | Pino wrapper, minimal |
| banner.js | 10 | Could be deleted (unused) |

### Files that Could Be Shorter
| File | Lines | Issue | Savings |
|---|---|---|---|
| securityManager.js | 548 | 4 classes in 1 file — fine for now, split later | 0 |
| auxpow.js | 455 | Well-structured, comments are valuable | 0 |
| index.js | 486 | Orchestrator — complexity is inherent | 0 |
| coins.js | 222 | Data file, every line is a coin definition | 0 |

Verdict: **No significant fat to cut.** Comments run 40-47% in utility
files — this is appropriate for crypto code where a wrong byte order
kills the entire system.

### Files that Need to Be Longer
| File | Lines | Missing |
|---|---|---|
| addressCodec.js | 228 | Bech32 checksum verification (noted in code) |
| banningManager.js | 348 | Database ban loading uses raw IP — needs CIDR support |

### Dead Code Found & Status
| Item | Status | Impact |
|---|---|---|
| WorkerTracker | Built, NOT wired in index.js | API falls back gracefully |
| DaemonHealthMonitor | Built, NOT wired in index.js | /health/full returns empty |
| banner.js | Imported but never used | Zero impact, 10 lines |
| ConnectionBanner import | Dead import in server.js | No effect |

### Redis Prefix Duplication
5 files manually construct Redis keys with `lux:` prefix. Should be
centralized to a single `redisKeys.js` helper. Functional but fragile.

---

## Would This Pool Function?

### YES — with the v0.4.1 + v0.5.0 fixes applied.

The emulation proves the math. Here's what happens end-to-end:

1. `getblocktemplate` returns block data from Litecoin daemon
2. Pool precomputes coinbase parts + merkle branches + reversed prevHash
3. Job is stored in `validJobs` Map AND broadcast to all miners
4. Miner's ASIC chips iterate nonces against the 80-byte header
5. When nonce produces a Scrypt hash below share difficulty → submitted
6. Pool looks up the STORED job (not current template — the v0.4.1 fix)
7. Pool rebuilds the EXACT same 80-byte header using stored data
8. Pool computes Scrypt hash → compares to stored job targets
9. Valid share → accepted, recorded to Redis + PostgreSQL
10. If hash also beats network target → full block submitted to daemon

**Emulation test proves step 7 produces byte-identical headers.**

### Would Public Miners Contribute Hashrate?

YES. The stratum protocol implementation matches the Antminer L9
firmware's expectations:
- `mining.subscribe` response: correct 3-element array format
- `mining.notify`: correct 9-parameter format
- `mining.submit`: correct 5-parameter parsing
- VarDiff adjusts difficulty per-miner
- Share acceptance/rejection uses standard error codes

A public miner configures:
```
Pool URL:   stratum+tcp://luxxpool.io:3333
Worker:     LhXk7rQEaGbfPDjmFiLGaNPAHt8N2dpczW.L9_01
Password:   x
```
Their L9 connects, subscribes, authorizes, receives jobs, and submits
shares. Each valid share contributes to the pool's hashrate and earns
proportional PPLNS rewards.

---

## Deployment Requirements

### Infrastructure Needed

**1. Server (Dedicated or VPS)**
- CPU: 4+ cores (share validation is CPU-bound via Scrypt)
- RAM: 8 GB minimum (16 GB recommended for Litecoin node)
- Storage: 100 GB SSD (Litecoin blockchain ~50 GB + aux chains)
- Network: 100 Mbps+ with static IP
- OS: Ubuntu 22.04 or 24.04 LTS

**2. Litecoin Core Node (REQUIRED — pool cannot function without it)**
- Must be fully synced to chain tip (~2.8M blocks)
- Configuration needed in litecoin.conf:
  ```
  server=1
  rpcuser=luxxpool_rpc
  rpcpassword=STRONG_PASSWORD
  rpcallowip=127.0.0.1
  rpcport=9332
  txindex=1
  ```
- Sync takes 12-48 hours depending on hardware

**3. PostgreSQL 16**
- Database: luxxpool
- User: luxxpool with full privileges
- Migrations create all tables automatically

**4. Redis 7**
- Default config works
- Used for share counting, dedup, caching

**5. DNS**
- A record: luxxpool.io → server IP
- Ports: 3333 (stratum), 3334 (SSL), 3336 (solo), 8080 (API)

**6. Optional: Auxiliary Chain Daemons**
- Dogecoin Core, Bellscoin, etc. for merged mining
- Each needs full sync + RPC config
- Pool works without them (LTC-only mode)

### Hosting Platforms

**Option A: Bare Metal (Recommended for mining)**
- Hetzner Dedicated: AX41-NVMe (~€39/mo) — 6-core Ryzen, 64GB RAM, 1TB NVMe
- OVH Advance-1: (~$60/mo) — similar specs
- Your own hardware at Christina Lake facility

**Option B: VPS (Works but less ideal)**
- DigitalOcean Dedicated CPU: 8 vCPU, 16GB RAM (~$96/mo)
- AWS EC2 c5.2xlarge: 8 vCPU, 16GB RAM (~$250/mo)
- Linode Dedicated 16GB (~$96/mo)

**Option C: Docker on any Linux host**
- `docker compose -f docker/docker-compose.yml up -d`
- Spins up: pool + PostgreSQL + Redis + Litecoin node

**NOT suitable:** Shared hosting, Vercel, Netlify, Heroku — these are
web hosting. Mining pool needs persistent TCP connections on custom ports.

### Deployment Steps

```bash
# 1. Clone repository
git clone https://github.com/aqua-019/luxxpool.git
cd luxxpool

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
nano .env  # Set all passwords, wallet addresses, RPC credentials

# 4. Start infrastructure (if using Docker)
docker compose -f docker/docker-compose.yml up -d postgres redis litecoind
# Wait for Litecoin to sync (12-48 hours)

# 5. Run migrations
npm run migrate

# 6. Start the pool
npm start

# 7. Verify
curl http://localhost:8080/health
# Should return: {"status":"ok","pool":"LUXXPOOL",...}

# 8. Point miners to stratum+tcp://YOUR_IP:3333
```

### Repository Structure for Deployment
```
luxxpool/                    # Main pool codebase
├── src/                     # 29 source files, 7210 lines
├── config/                  # Environment-based configuration
├── migrations/              # Database schema (auto-run)
├── docker/                  # Dockerfile + docker-compose
├── tests/                   # Emulation tests
│   └── emulation.js         # 45-test mining pipeline validation
├── docs/                    # Audit reports
├── .env.example             # Configuration template
└── package.json             # Dependencies + scripts

luxxpool-dashboard/          # Public dashboard (separate repo)
├── src/App.jsx              # React dashboard
├── index.html               # Entry point
└── vite.config.js           # Build config
```

The pool codebase and dashboard are separate repos. The pool serves
a REST API on :8080 that the dashboard consumes. In production, the
dashboard would be deployed to Vercel/Cloudflare Pages pointing at
the pool API.
