<p align="center">
  <strong>LUXXPOOL v0.8.1</strong><br>
  <em>Scrypt Multi-Coin Merged Mining Pool</em><br>
  Christina Lake, BC, Canada
</p>

---

Mine Litecoin once. Earn 10 coins simultaneously. Zero fee for fleet operators.

LUXXPOOL is a production Scrypt mining pool that mines Litecoin as the parent chain and automatically earns rewards from 9 auxiliary chains via AuxPoW merged mining. Fleet miners pay 0% fees. Public miners pay 2% — offset by merged mining revenue that makes the effective cost negative compared to LTC-only pools.

---

## How It Works

```
   YOUR MINER                          LUXXPOOL                         BLOCKCHAINS
  ┌──────────┐                    ┌──────────────┐
  │ Antminer │ ── stratum+tcp ──> │   Stratum    │
  │   L9     │     :3333          │   Server     │
  │ 17 GH/s  │                    │              │
  └──────────┘                    │  VarDiff     │
  ┌──────────┐                    │  adjusts     │          ┌─────────────────────┐
  │ ElphaPex │ ── stratum+ssl ──> │  difficulty   │ ──────> │  LTC  (parent)      │
  │   DG2    │     :3334          │  per miner   │          │  DOGE (aux)         │
  │ 17 GH/s  │                    │              │          │  BELLS, LKY, PEP    │
  └──────────┘                    │  Validates   │          │  JKC, DINGO, SHIC   │
  ┌──────────┐                    │  shares via  │          │  TRMP, CRC (soon)   │
  │ Solo     │ ── stratum+tcp ──> │  async       │          └─────────────────────┘
  │ Miner    │     :3336          │  scrypt      │                    │
  └──────────┘                    └──────┬───────┘                    │
                                         │                            │
                                    ┌────▼────────┐          ┌───────▼──────────┐
                                    │  9-Layer     │          │  Block Found?    │
                                    │  Security    │          │  Submit to all   │
                                    │  Engine      │          │  10 chains       │
                                    └────┬────────┘          └───────┬──────────┘
                                         │                            │
                                    ┌────▼──────────────────────┐    │
                                    │  PPLNS Payment Engine     │◄───┘
                                    │  Fleet: 0%  Pool: 2%     │
                                    │  Solo: 1%   Auto-retry   │
                                    │  Fee transparency ledger  │
                                    └────┬──────────────────────┘
                                         │
                                    ┌────▼──────────────────────┐
                                    │  LTC + 9 Aux Coin Payouts │
                                    │  Direct to your wallets   │
                                    └───────────────────────────┘
```

---

## Supported Coins

| Coin | Symbol | Role | Block Time | Reward | Confirmations |
|------|--------|------|------------|--------|---------------|
| **Litecoin** | LTC | Parent | 2.5 min | 6.25 LTC | 100 |
| Dogecoin | DOGE | Auxiliary | 1 min | 10,000 DOGE | 40 |
| Bellscoin | BELLS | Auxiliary | 1 min | Random | 20 |
| Luckycoin | LKY | Auxiliary | 1 min | Halving | 20 |
| Pepecoin | PEP | Auxiliary | 1 min | Halving | 20 |
| Junkcoin | JKC | Auxiliary | 1 min | Halving | 20 |
| Dingocoin | DINGO | Auxiliary | 1 min | Variable | 20 |
| Shibacoin | SHIC | Auxiliary | 1 min | Halving | 20 |
| TrumPOW | TRMP | Auxiliary | 1 min | Variable | 20 |
| CraftCoin | CRC | Auxiliary | 1 min | Variable | 20 |

All auxiliary coins are mined automatically with zero extra configuration. Connect once, earn everything.

---

## Connect Your Miner

### Pool Mining (PPLNS, 2% fee)
```
stratum+tcp://luxxpool.io:3333
Worker: YOUR_LTC_ADDRESS.workerName
Password: x
```

### SSL Stratum (Encrypted)
```
stratum+ssl://luxxpool.io:3334
Worker: YOUR_LTC_ADDRESS.workerName
Password: x
```

### Solo Mining (100% of block, 1% fee)
```
stratum+tcp://luxxpool.io:3336
Worker: YOUR_LTC_ADDRESS.workerName
Password: x
```

### Fleet Mining (0% fee)
Fleet miners connect to the same ports. Classification is automatic via IP/address whitelist — no special configuration on the miner side.

---

## Fleet Management

LUXXPOOL is built fleet-first. The operator's own hardware gets priority treatment.

```
  ┌─── Christina Lake Facility ───────────────────────┐
  │                                                    │
  │   40x Antminer L9  ──┐                            │
  │   (10.0.0.0/24)      ├──> FLEET (0% fee)          │
  │                       │    No banning              │
  │   Future expansion:   │    No rate limits          │
  │   60 more slots ──────┘    No security checks      │
  │                                                    │
  └────────────────────────────────────────────────────┘

  ┌─── Public Internet ───────────────────────────────┐
  │                                                    │
  │   Anyone with an L9/L7/DG2 ──> POOL (2% fee)      │
  │   Solo miners ──────────────── SOLO (1% fee)       │
  │                                                    │
  │   Full 9-layer security pipeline active            │
  │   VarDiff, rate limiting, reputation scoring       │
  │                                                    │
  └────────────────────────────────────────────────────┘
```

**Configuration** (`.env`):
```bash
FLEET_IPS=10.0.0.0/24           # CIDR block for your facility
FLEET_FEE=0                      # 0% fee
FLEET_MAX_MINERS=100             # Scale as fleet grows
```

**Runtime scaling** — no restart required:
```
POST /api/v1/fleet/ip          # Add IP/CIDR to fleet
DELETE /api/v1/fleet/ip        # Remove IP
PUT /api/v1/fleet/capacity     # Resize fleet cap (40 → 60 → 100+)
```

Currently tested and proven for **40 L9 miners** (680 GH/s) with headroom to 100+.

---

## Nine-Layer Security Engine

Every public miner connection passes through 9 sequential security layers. Fleet miners bypass the pipeline entirely.

```
  Incoming Connection
        │
   L1   │  Transport Security ──── TLS enforcement, cipher validation
        │
   L2   │  Protocol Hardening ──── JSON validation, buffer limits, message caps
        │
   L3   │  Auth & Cookies ──────── HMAC mining cookies, anti-hijack
        │
   L4   │  Share Fingerprinting ── Statistical BWH/FAW attack detection
        │
   L5   │  Behavioral Anomaly ──── Share flooding, ntime gaming, Sybil detection
        │
   L6   │  Rate Limiting ───────── Per-IP burst control, DDoS guard
        │
   L7   │  Identity Validation ─── Address format, payout integrity
        │
   L8   │  Reputation Scoring ──── Long-term per-miner trust score (0-1000)
        │
   L9   │  Audit Trail ─────────── Immutable forensic event ledger
        │
        ▼
  Share Processor (if all layers pass)
```

**Additional security systems:**
- **Emergency Lockdown** — 4 graduated levels (Normal → Elevated → Restricted → Maintenance) with auto-escalation on DDoS/attack detection
- **IP Reputation** — 0-100 score with behavioral decay, auto-reject at threshold
- **Connection Fingerprinting** — Botnet cluster detection via behavioral hashing
- **Progressive Banning** — 1hr → 24hr → permanent, with subnet-level banning
- **Forensic Audit Log** — Every security event persisted to PostgreSQL with 90-day retention

---

## Payment System

### PPLNS (Pay Per Last N Shares)

```
  Block Found at Height 50,000
        │
        ▼
  ┌─────────────────────────────┐
  │  Look back 100 blocks       │  ← ~4.2 hours of shares
  │  (PPLNS window)             │
  │                             │
  │  Fleet Miner A: 60% shares  │──> 60% of 6.25 LTC = 3.750 LTC (0% fee)
  │  Fleet Miner B: 20% shares  │──> 20% of 6.25 LTC = 1.250 LTC (0% fee)
  │  Public Miner:  15% shares  │──> 15% of 6.25 LTC × 0.98 = 0.919 LTC (2% fee)
  │  Public Miner:   5% shares  │──> 5% of 6.25 LTC × 0.98 = 0.306 LTC (2% fee)
  │                             │
  │  Pool fee collected: 0.025 LTC  (only from public miners)
  └─────────────────────────────┘
```

### Fee Transparency

Every block payout is recorded in a public audit ledger:

```
GET /api/v1/pool/fee-audit

{
  "summary": { "blocks": 142, "total_gross": "887.50", "total_fees": "3.55", "avg_fee_pct": "0.004" },
  "ledger": [
    { "block_height": 50000, "gross_reward": "6.25", "pool_fee_pct": "0.004",
      "pool_fee_amount": "0.025", "net_distributed": "6.225", "payout_txid": "abc123..." }
  ]
}
```

Anyone can verify the pool's honesty. No other major Scrypt pool offers this.

### Payment Safety

- **Idempotent records** — payments marked `pending` before `sendmany()`, updated to `sent` after
- **Automatic retry** — failed payments retried every cycle until successful
- **Per-coin maturity** — LTC waits 100 confirmations, DOGE 40, others 20
- **Auto-wallet registration** — aux coin wallet slots created on first share; rewards accumulate until addresses registered

---

## Miner Model Detection

LUXXPOOL identifies your hardware from the Stratum user-agent and optimizes difficulty automatically.

| Miner | Expected Hashrate | Optimal Start Difficulty |
|-------|-------------------|------------------------|
| Antminer L9 | 17 GH/s | 8192 |
| Antminer L7 | 9.5 GH/s | 4096 |
| ElphaPex DG2 | 17 GH/s | 8192 |
| VOLCMINER D1 | 11 GH/s | 8192 |
| Goldshell LT6 | 3.35 GH/s | 1024 |
| Antminer L3+ | 504 MH/s | 512 |

VarDiff adjusts every 90 seconds targeting 1 share per 15 seconds. Model-aware floors prevent high-hashrate miners from gaming low difficulty.

---

## Monitoring

### WebSocket Real-Time

```
ws://luxxpool.io/ws

Channels:
  pool     → hashrate, miners, blocks (every 10s)
  blocks   → instant notification on block found
  miner:   → per-address worker stats (every 30s)
  admin    → security events, lockdown changes (auth required)
```

### Health Monitoring

- Daemon sync tracking (LTC, DOGE, all aux chains)
- Redis/PostgreSQL connectivity
- System memory and CPU
- Per-miner hashrate estimation (10-minute rolling window)
- Worker tracking with 1-hour idle pruning
- Hashrate optimization with underperformance alerts

---

## API Reference

### Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health check |
| GET | `/api/v1/pool/stats` | Pool hashrate, miners, network difficulty |
| GET | `/api/v1/pool/overview` | Full system overview |
| GET | `/api/v1/pool/hashrate` | Hashrate history |
| GET | `/api/v1/pool/hashrate/live` | Real-time pool hashrate |
| GET | `/api/v1/pool/stale-rate` | Pool-wide stale share rate |
| GET | `/api/v1/pool/fee-audit` | Fee transparency ledger |
| GET | `/api/v1/coins` | All supported coins |
| GET | `/api/v1/aux/status` | Aux chain connection status |
| GET | `/api/v1/aux/:coin/blocks` | Aux blocks found per coin |
| GET | `/api/v1/miner/:address` | Miner stats and workers |
| GET | `/api/v1/miner/:address/hashrate` | Hashrate history |
| GET | `/api/v1/miner/:address/hashrate/live` | Real-time miner hashrate |
| GET | `/api/v1/miner/:address/wallets` | Registered aux wallets + unregistered list |
| POST | `/api/v1/miner/:address/wallets` | Register aux coin wallet |
| POST | `/api/v1/miner/:address/wallets/bulk` | Bulk register all aux wallets |
| DELETE | `/api/v1/miner/:address/wallets/:coin` | Remove a registered wallet |
| GET | `/api/v1/miner/:address/shares/audit` | Share history with reject reasons |
| GET | `/api/v1/miners/active` | Currently connected miners |
| GET | `/api/v1/blocks` | All found blocks (paginated) |
| GET | `/api/v1/blocks/pending` | Blocks awaiting confirmation |
| GET | `/api/v1/payments` | Recent payouts |
| GET | `/api/v1/solo/miners` | Connected solo miners |
| GET | `/api/v1/solo/blocks` | Solo-found blocks |
| GET | `/api/v1/workers` | Per-worker stats |
| GET | `/api/v1/estimate/profit` | Profit estimator by hashrate |
| GET | `/api/v1/estimate/miners` | Pre-built estimates for common ASICs |
| GET | `/api/v1/health/full` | Full daemon/redis/postgres health |
| GET | `/api/v1/diagnostics` | Complete pool diagnostics |

### Admin Endpoints (Bearer token required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/fleet/overview` | Fleet vs public summary |
| GET | `/api/v1/fleet/miners` | Fleet miner details |
| GET | `/api/v1/fleet/config` | IP/address whitelist |
| POST | `/api/v1/fleet/ip` | Add IP/CIDR to fleet |
| DELETE | `/api/v1/fleet/ip` | Remove fleet IP |
| POST | `/api/v1/fleet/address` | Add address to fleet |
| DELETE | `/api/v1/fleet/address` | Remove fleet address |
| PUT | `/api/v1/fleet/capacity` | Update fleet capacity |
| GET | `/api/v1/security/status` | 9-layer engine status |
| GET | `/api/v1/security/events` | Security event log |
| GET | `/api/v1/security/engine/audit` | SecurityEngine audit trail |
| GET | `/api/v1/security/reputation/:address` | Miner reputation score |
| GET | `/api/v1/admin/bans` | Currently banned IPs |
| GET | `/api/v1/dashboard/*` | 8 dashboard data endpoints |

---

## Quickstart

```bash
# 1. Clone and configure
git clone https://github.com/aqua-019/luxxpooltest.git
cd luxxpooltest
cp .env.example .env
# Edit .env with your RPC credentials, wallet addresses, fleet IPs

# 2. Docker deploy (recommended)
docker compose -f docker/docker-compose.prod.yml up -d

# 3. Or run directly
npm install
npm start    # Runs migrations automatically on first boot

# 4. Verify
curl http://localhost:8080/health
```

---

## Project Structure

```
luxxpool/
├── src/
│   ├── index.js                        # System orchestrator — wires all 44 modules
│   ├── stratum/
│   │   ├── server.js                   # Stratum v1 TCP server (10,000 conn cap)
│   │   ├── ssl.js                      # TLS stratum (:3334)
│   │   ├── solo.js                     # Solo mining server (:3336)
│   │   └── vardiff.js                  # Model-aware variable difficulty
│   ├── blockchain/
│   │   ├── rpcClient.js                # JSON-RPC with circuit breaker
│   │   ├── blockTemplate.js            # Coinbase builder + aux merkle root embedding
│   │   ├── auxpow.js                   # AuxPoW engine (9 chains, Redis-locked submissions)
│   │   ├── blockNotifier.js            # ZMQ + polling block detection
│   │   └── zmqNotifier.js              # ZMQ subscriber
│   ├── pool/
│   │   ├── shareProcessor.js           # Async scrypt validation + share audit
│   │   ├── securityEngine.js           # 9-layer security pipeline (1200+ lines)
│   │   ├── fleetManager.js             # Fleet classification + CIDR whitelisting
│   │   ├── banningManager.js           # Progressive IP banning
│   │   ├── emergencyLockdown.js        # 4-level graduated lockdown
│   │   ├── ipReputation.js             # IP trust scoring (0-100)
│   │   ├── connectionFingerprint.js    # Botnet cluster detection
│   │   ├── auditLog.js                 # Forensic event logging
│   │   ├── minerRegistry.js            # ASIC model detection (8 profiles)
│   │   ├── firmwareTracker.js          # Firmware version tracking
│   │   ├── hashrateOptimizer.js        # Per-miner efficiency analysis
│   │   └── redisDedup.js               # Share dedup with in-memory fallback
│   ├── payment/
│   │   ├── paymentProcessor.js         # LTC PPLNS + retry + fee ledger
│   │   └── multiCoinPayment.js         # Aux coin payouts with wallet lookup
│   ├── api/
│   │   ├── server.js                   # Express + rate limiting
│   │   ├── websocket.js                # Real-time WebSocket (4 channels)
│   │   └── routes/
│   │       ├── extended.js             # Coins, aux, wallets, fee-audit, share-audit
│   │       ├── pool.js                 # Health, workers, diagnostics, profit
│   │       ├── fleet.js                # Fleet CRUD + capacity management
│   │       ├── security.js             # Security engine + reputation
│   │       └── dashboard.js            # 8 dashboard data endpoints
│   ├── monitoring/
│   │   ├── hashrateEstimator.js        # 10-min rolling hashrate
│   │   ├── statsCollector.js           # Periodic DB snapshots
│   │   ├── workerTracker.js            # Per-worker stats + idle pruning
│   │   └── healthMonitor.js            # Daemon/Redis/Postgres health
│   ├── workers/
│   │   └── blockWatcher.js             # Confirmation tracking + orphan detection
│   └── utils/
│       ├── hashing.js                  # Scrypt (sync+async), SHA256d, merkle, targets
│       ├── addressCodec.js             # Base58Check + Bech32/Bech32m decoder
│       ├── database.js                 # PostgreSQL pool + migration runner
│       ├── redisKeys.js                # Centralized Redis key builder
│       ├── profitEstimator.js          # Daily profit calculator
│       └── logger.js                   # Pino structured logging
├── config/
│   ├── index.js                        # Environment config + validation
│   └── coins.js                        # 10 Scrypt coin definitions
├── migrations/                          # 001-011 PostgreSQL migrations (19+ tables)
├── deploy/
│   ├── nginx.conf                      # Nginx: SSL, rate limiting, WebSocket proxy
│   └── nginx/luxxpool.conf             # Nginx: admin IP gating, CORS, OCSP
├── docker/
│   ├── docker-compose.yml              # Development stack
│   └── docker-compose.prod.yml         # Production: health checks, resource limits
├── tests/
│   ├── run-all.js                      # Test orchestrator
│   ├── emulation.js                    # A+B: Mining pipeline + fleet (109 tests)
│   ├── emulation-c.js                  # C: Security + address + VarDiff (32 tests)
│   └── emulation-d.js                  # D: Full lifecycle — 40 L9s + public (36 tests)
└── .env.example                         # Full configuration template
```

---

## Testing

```bash
npm test

═══════════════════════════════════════════════════════
 LUXXPOOL v0.8.1 — FULL TEST SUITE
═══════════════════════════════════════════════════════

  Emulation A+B (Mining Pipeline + Fleet):       109 passed
  Emulation C (Address + Security + VarDiff):      32 passed
  Emulation D (Full Pool Lifecycle + 40 L9s):      36 passed

  TOTAL: 177 passed, 0 failed
  ALL TEST SUITES PASSED
```

**Emulation D** proves the complete pool lifecycle: 40 fleet L9 miners register via CIDR, public and solo miners connect alongside, PPLNS distributes with correct fee tiers, solo blocks pay 99%, failed payments retry, fee ledger records, auto-wallets created, share audit captures valid/rejected/stale.

---

## Stack

| Component | Version | Purpose |
|-----------|---------|---------|
| Node.js | 20+ | Pool runtime |
| PostgreSQL | 16 | Persistent storage (19+ tables) |
| Redis | 7 | Share dedup, rate limiting, balance tracking |
| Express | 4 | REST API + rate limiting |
| ws | 8 | WebSocket real-time updates |
| pino | 8 | Structured JSON logging |

---

## License

Proprietary. All rights reserved.

---

*LUXXPOOL — Aquatic Mining Operations — Christina Lake, BC, Canada*
