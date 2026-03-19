# LUXXPOOL

**Scrypt Multi-Coin Merged Mining Pool**
*Litecoin + 9 Auxiliary AuxPoW Chains — Christina Lake, BC, Canada*

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  LUXXPOOL v0.2.0  —  Scrypt Mining              │
│                                                                 │
│  Stratum      SSL Stratum    Solo Mining    REST API            │
│   :3333         :3334          :3336         :8080              │
├─────────────┬──────────────┬───────────────┬────────────────────┤
│  Banning    │  VarDiff     │  Hashrate     │  Stats Collector   │
│  Manager    │  Manager     │  Estimator    │  (per-miner)       │
├─────────────┴──────────────┴───────────────┴────────────────────┤
│                    Share Processor                               │
│         Validates shares ← Detects blocks ← VarDiff            │
├─────────────────────────────────────────────────────────────────┤
│    Block Template Manager     │      AuxPoW Engine              │
│    (LTC parent chain work)    │   (9 auxiliary chains)          │
│                               │   createauxblock/submitauxblock │
├───────────────────────────────┴─────────────────────────────────┤
│  Block Confirmation     │  LTC Payment    │  Multi-Coin         │
│  Watcher (all coins)    │  Processor      │  Payment Processor  │
├─────────────────────────┴─────────────────┴─────────────────────┤
│                    Blockchain Daemons (RPC)                      │
│  LTC │ DOGE │ BELLS │ LKY │ PEP │ JKC │ DINGO │ SHIC │ ...    │
├─────────────────────────────────────────────────────────────────┤
│           PostgreSQL 16        │        Redis 7                  │
└────────────────────────────────┴────────────────────────────────┘
```

## Supported Coins (Scrypt Algorithm)

| Coin | Symbol | Role | Block Time | Block Reward | Payout Threshold |
|------|--------|------|------------|-------------|-----------------|
| **Litecoin** | LTC | Parent | 2.5 min | 6.25 LTC | 0.01 LTC |
| Dogecoin | DOGE | Auxiliary | 1 min | 10,000 DOGE | 40 DOGE |
| Bellscoin | BELLS | Auxiliary | 1 min | Random | 1 BELLS |
| Luckycoin | LKY | Auxiliary | 1 min | Halving | 0.1 LKY |
| Pepecoin | PEP | Auxiliary | 1 min | Halving | 20,000 PEP |
| Junkcoin | JKC | Auxiliary | 1 min | Halving | 5 JKC |
| Dingocoin | DINGO | Auxiliary | 1 min | Variable | 1,000 DINGO |
| Shibacoin | SHIC | Auxiliary | 1 min | Halving | 40,000 SHIC |
| TrumPOW | TRMP | Auxiliary | 1 min | Variable | 400,000 TRMP |
| CraftCoin | CRC | Auxiliary | 1 min | Variable | 1 CRC |

**All auxiliary coins are mined automatically.** Miners connect once to mine LTC and earn all aux coin rewards simultaneously via AuxPoW (Auxiliary Proof of Work). No extra configuration needed.

## Quickstart

```bash
# 1. Clone and configure
cp .env.example .env
# Edit .env with your RPC credentials and wallet addresses for each coin

# 2. Docker deploy (recommended)
docker compose -f docker/docker-compose.yml up -d

# 3. Or run directly
npm install
npm run migrate
npm start
```

## Miner Connection

### Pool Mining (Shared Rewards — 2% fee)
```
stratum+tcp://luxxpool.io:3333
Worker: YOUR_LTC_ADDRESS.workerName
Password: x
```

### SSL Stratum (Encrypted)
```
stratum+ssl://luxxpool.io:3334
```

### Solo Mining (Keep 100% — 1% fee)
```
stratum+tcp://luxxpool.io:3336
Worker: YOUR_LTC_ADDRESS.workerName
Password: x
```

## Project Structure

```
luxxpool/
├── src/
│   ├── index.js                     # Main orchestrator — wires all systems
│   ├── stratum/
│   │   ├── server.js                # Stratum v1 TCP server + client mgmt
│   │   ├── ssl.js                   # TLS-encrypted stratum (:3334)
│   │   ├── solo.js                  # Solo mining server (:3336)
│   │   ├── vardiff.js               # Variable difficulty per-miner
│   │   └── banner.js                # Pool identity
│   ├── blockchain/
│   │   ├── rpcClient.js             # JSON-RPC client for all daemons
│   │   ├── blockTemplate.js         # LTC block template + coinbase builder
│   │   └── auxpow.js               # AuxPoW engine (9 auxiliary chains)
│   ├── pool/
│   │   ├── shareProcessor.js        # Share validation + block detection
│   │   └── banningManager.js        # DDoS protection + abuse banning
│   ├── payment/
│   │   ├── paymentProcessor.js      # LTC PPLNS payout processor
│   │   └── multiCoinPayment.js      # Multi-coin payout processor
│   ├── api/
│   │   ├── server.js                # Express REST API
│   │   └── routes/extended.js       # Multi-coin, aux, solo, wallet routes
│   ├── monitoring/
│   │   ├── statsCollector.js        # Periodic pool stats snapshots
│   │   └── hashrateEstimator.js     # Real-time hashrate from shares
│   ├── workers/
│   │   └── blockWatcher.js          # Block confirmation + orphan detection
│   └── utils/
│       ├── logger.js                # Pino structured logging
│       ├── hashing.js               # Scrypt, SHA256d, merkle, difficulty
│       └── database.js              # PostgreSQL pool + migrations
├── config/
│   ├── index.js                     # Environment-based config loader
│   └── coins.js                     # All 10 Scrypt coin definitions
├── migrations/
│   ├── 001_initial_schema.js        # Core tables
│   ├── 002_multi_coin_support.js    # Multi-coin wallets, aux blocks, solo
│   └── run.js                       # Migration runner
├── docker/
│   ├── Dockerfile                   # Production container
│   └── docker-compose.yml           # Full stack with aux chain daemons
├── web/
│   └── dashboard.jsx                # React mining dashboard
└── tests/
```

## API Endpoints

### Pool
| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /api/v1/pool/stats` | Pool hashrate, miners, network |
| `GET /api/v1/pool/overview` | Full overview with all systems |
| `GET /api/v1/pool/hashrate` | Hashrate history |
| `GET /api/v1/pool/hashrate/live` | Real-time hashrate |

### Coins & Aux Chains
| Endpoint | Description |
|---|---|
| `GET /api/v1/coins` | All supported coins |
| `GET /api/v1/aux/status` | Aux chain connection status |
| `GET /api/v1/aux/:coin/blocks` | Blocks found per aux coin |

### Miners
| Endpoint | Description |
|---|---|
| `GET /api/v1/miner/:address` | Miner stats + workers |
| `GET /api/v1/miner/:address/hashrate` | Hashrate history |
| `GET /api/v1/miner/:address/hashrate/live` | Real-time hashrate |
| `GET /api/v1/miner/:address/wallets` | Registered coin wallets |
| `POST /api/v1/miner/:address/wallets` | Register aux coin wallet |
| `GET /api/v1/miners/active` | Connected pool miners |

### Solo Mining
| Endpoint | Description |
|---|---|
| `GET /api/v1/solo/miners` | Connected solo miners |
| `GET /api/v1/solo/blocks` | Solo-found blocks |

### Blocks & Payments
| Endpoint | Description |
|---|---|
| `GET /api/v1/blocks` | All found blocks |
| `GET /api/v1/blocks/pending` | Blocks awaiting confirmation |
| `GET /api/v1/payments` | Recent payouts |

### Admin
| Endpoint | Description |
|---|---|
| `GET /api/v1/admin/bans` | Currently banned IPs |

---

*LUXXPOOL — Aquatic Mining Operations — Christina Lake, BC*
