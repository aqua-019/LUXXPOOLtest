# LUXXPOOL v0.6.0 — Documentation Index

## Engineering Documents

| Document | Path | Content |
|----------|------|---------|
| Tech Debt Registry | `docs/engineering/TECH_DEBT.md` | 10 items, severity-ranked, effort estimates |
| Code Review | `docs/engineering/CODE_REVIEW.md` | Architecture, security findings, patterns |
| System Design | `docs/engineering/SYSTEM_DESIGN.md` | Component registry, data flows, scaling |
| Incident Response | `docs/engineering/INCIDENT_RESPONSE.md` | 8 runbooks, escalation matrix |
| Testing Strategy | `docs/engineering/TESTING_STRATEGY.md` | Coverage map, 54 planned tests |
| Documentation Index | `docs/engineering/DOCUMENTATION.md` | This file |

## Operational Documents

| Document | Path | Content |
|----------|------|---------|
| Deployment Guide | `deploy/DEPLOYMENT.md` | Full server setup, SSL, systemd, Docker |
| Nginx Config | `deploy/nginx.conf` | Reverse proxy, rate limiting, CORS |
| Environment Template | `.env.example` | All configuration variables |

## API Reference

### Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (200 = OK) |
| GET | `/api/v1/pool/stats` | Pool hashrate, miners, blocks, difficulty |
| GET | `/api/v1/pool/blocks` | Recent blocks with confirmation status |
| GET | `/api/v1/pool/payments` | Recent payment transactions |
| GET | `/api/v1/miner/:address` | Miner stats (hashrate, shares, balance) |
| GET | `/api/v1/miner/:address/workers` | Worker breakdown for a miner |
| GET | `/api/v1/miner/:address/payments` | Payment history for a miner |
| GET | `/api/v1/coin/:coin/blocks` | Blocks found for specific coin |

### Private Endpoints (localhost only via Nginx)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/fleet/overview` | Fleet vs public miner breakdown |
| GET | `/api/v1/fleet/miners` | All fleet miner details |
| POST | `/api/v1/fleet/ip` | Add IP to fleet whitelist |
| POST | `/api/v1/fleet/address` | Add address to fleet whitelist |
| DELETE | `/api/v1/fleet/ip` | Remove IP from fleet |
| DELETE | `/api/v1/fleet/address` | Remove address from fleet |
| PUT | `/api/v1/fleet/capacity` | Set max fleet miner count |
| GET | `/api/v1/security/events` | Security event log |
| GET | `/api/v1/security/bans` | Currently banned IPs |
| GET | `/api/v1/security/layers` | Security layer status |
| GET | `/api/v1/pool/workers` | All connected workers |
| GET | `/api/v1/pool/health` | Daemon/DB/Redis health status |

### Stratum Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 3333 | `stratum+tcp` | Pool mining (PPLNS, 2% fee) |
| 3334 | `stratum+ssl` | Encrypted pool mining |
| 3336 | `stratum+tcp` | Solo mining (1% fee) |

### Worker Format

```
Worker: YOUR_LTC_ADDRESS.workerName
Password: x (ignored)
```

Address formats accepted: P2PKH (L...), P2SH (M...), Bech32 (ltc1q...), Bech32m (ltc1p...).

## Configuration Reference

See `.env.example` for all variables. Key groups:

| Group | Variables | Notes |
|-------|-----------|-------|
| Litecoin | LTC_HOST, LTC_PORT, LTC_USER, LTC_PASS, LTC_ADDRESS | Daemon must be fully synced |
| ZMQ | LTC_ZMQ_HASHBLOCK | Optional. Add `zmqpubhashblock` to litecoin.conf |
| PostgreSQL | PG_HOST, PG_PORT, PG_USER, PG_PASS, PG_DATABASE | Run migrations first |
| Redis | REDIS_HOST, REDIS_PORT, REDIS_PASS, REDIS_PREFIX | Default prefix: `lux:` |
| Pool | POOL_FEE, POOL_FEE_ADDRESS | Fee is decimal (0.02 = 2%) |
| Fleet | FLEET_IPS, FLEET_ADDRESSES, FLEET_FEE, FLEET_MAX_MINERS | Comma-separated |
| Aux chains | COIN_ENABLED, COIN_HOST, COIN_PORT, COIN_USER, COIN_PASS, COIN_ADDRESS | Per chain |

## Database Schema

### Tables (3 migrations)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| blocks | LTC blocks found | height, hash, reward, worker, confirmed |
| shares | Share records | miner_address, difficulty, valid, block_height |
| payments | Payout history | address, amount, txid, coin |
| aux_blocks | Auxiliary chain blocks | coin, height, hash, reward |
| bans | IP ban history | ip, reason, created_at, expires_at |
| security_events | Security alerts | type, ip, details, severity |

## Monitoring

The pool exposes monitoring data through:

1. **API endpoints** — `/api/v1/pool/stats`, `/api/v1/pool/health`
2. **Structured logs** — Pino JSON logging, pipe to any log aggregator
3. **Health monitor events** — daemonDown, daemonBehind, redisDown, postgresDown, highMemory
4. **Worker tracker** — per-worker lifecycle and stats in DB
