# LUXXPOOL v0.6.0 — Incident Response Playbook

## Severity Levels

| Level | Definition | Response Time | Examples |
|-------|-----------|---------------|----------|
| P0 | Pool offline, miners disconnected, blocks missed | Immediate | Stratum crash, LTC daemon down |
| P1 | Degraded but operational, revenue impact | < 15 min | Redis down, high reject rate, payment failure |
| P2 | Functionality impaired, no revenue impact | < 1 hour | API down, monitoring gaps, aux chain offline |
| P3 | Cosmetic or non-urgent | Next business day | Dashboard errors, log rotation, disk space |

## Runbook: Stratum Server Down (P0)

**Symptoms:** All miners disconnected, zero hashrate, no shares in Redis.

**Diagnosis:**
```bash
# Check if process is running
systemctl status luxxpool
journalctl -u luxxpool --since "5 min ago" -p err

# Check port
ss -tlnp | grep 3333

# Check for crash
journalctl -u luxxpool | grep "uncaughtException\|unhandledRejection" | tail -5
```

**Resolution:**
```bash
# Restart
systemctl restart luxxpool

# If crash-looping, check logs for root cause
journalctl -u luxxpool -f

# If port conflict
fuser -k 3333/tcp
systemctl start luxxpool
```

**Verification:** `echo '{"id":1,"method":"mining.subscribe","params":[]}' | nc localhost 3333`

---

## Runbook: Litecoin Daemon Down (P0)

**Symptoms:** Template errors in logs, stale work being sent, "getblocktemplate failed" errors.

**Diagnosis:**
```bash
litecoin-cli getblockchaininfo
litecoin-cli getnetworkinfo
systemctl status litecoind
```

**Resolution:**
```bash
# If stopped
systemctl start litecoind

# If syncing (blocks < headers)
litecoin-cli getblockchaininfo | grep -E "blocks|headers"
# Wait for sync — pool sends stale work until caught up

# If corrupted
systemctl stop litecoind
litecoin-cli -reindex
systemctl start litecoind
# Reindex takes 12-48 hours
```

**Impact during downtime:** Pool continues accepting shares (stored in Redis) but cannot validate blocks or update templates. Miners receive stale work after ~15 seconds (ZMQ polling fallback). Blocks found during downtime are lost.

---

## Runbook: Redis Down (P1)

**Symptoms:** Share dedup fails, "Redis connection refused" in logs, balances not updating.

**Diagnosis:**
```bash
redis-cli ping
systemctl status redis
redis-cli info memory
```

**Resolution:**
```bash
# If stopped
systemctl start redis

# If OOM
redis-cli config set maxmemory 1gb
redis-cli config set maxmemory-policy allkeys-lru

# If corrupted AOF
redis-check-aof --fix /var/lib/redis/appendonly.aof
systemctl restart redis
```

**Impact during downtime:** Shares accepted but dedup disabled (risk of duplicate share credit). Balances stop updating. Pool remains operational — shares flow to PostgreSQL.

---

## Runbook: PostgreSQL Down (P1)

**Symptoms:** "Connection refused" errors, share recording fails, payments halt.

**Diagnosis:**
```bash
pg_isready -h localhost -U luxxpool
systemctl status postgresql
tail -50 /var/log/postgresql/postgresql-16-main.log
```

**Resolution:**
```bash
# If stopped
systemctl start postgresql

# If disk full
df -h /var/lib/postgresql
# Free space: VACUUM FULL, remove old WAL, expand disk

# If max connections
sudo -u postgres psql -c "SELECT count(*) FROM pg_stat_activity;"
sudo -u postgres psql -c "ALTER SYSTEM SET max_connections = 200;"
systemctl restart postgresql
```

**Impact during downtime:** Shares validated but not recorded to DB. Payments halt. Pool mining continues (hashrate maintained). Shares resume recording when DB returns.

---

## Runbook: High Reject Rate (P1)

**Symptoms:** Reject rate > 5%, miners reporting "stale" or "invalid" shares.

**Diagnosis:**
```bash
# Check current stats
curl -s http://localhost:8080/api/v1/pool/stats | jq '.rejectRate'

# Check template age
journalctl -u luxxpool | grep "template\|new block" | tail -10

# Check ZMQ
journalctl -u luxxpool | grep "ZMQ" | tail -5
```

**Common causes:**
1. **Template update delay:** ZMQ disconnected, fell back to 15s polling → miners work on stale templates
2. **Clock skew:** Miner ntime drifts from server time → shares rejected
3. **VarDiff too high:** Miners can't find shares fast enough → all shares stale by submission time
4. **Network latency:** High latency between miner and pool → shares arrive after template change

**Resolution:**
```bash
# Force template update
curl -X POST http://localhost:8080/api/v1/pool/template/refresh

# Check ZMQ endpoint
echo '{"id":1,"method":"getzmqnotifications","params":[]}' | litecoin-cli

# Reduce VarDiff target if needed (in .env)
# VARDIFF_TARGET_TIME=20  (increase from 15 to give more time)
```

---

## Runbook: Security Alert — Share Flood (P1)

**Symptoms:** SHARE_FLOOD events in logs, single IP submitting > 10 shares/sec.

**Diagnosis:**
```bash
curl -s http://localhost:8080/api/v1/security/events | jq '.[] | select(.type=="SHARE_FLOOD")'
curl -s http://localhost:8080/api/v1/security/bans
```

**Resolution:** Automatic — L3 anomaly engine auto-bans the IP. Verify:
```bash
# Confirm ban
curl -s http://localhost:8080/api/v1/security/bans | jq '.[] | select(.ip=="OFFENDING_IP")'

# If attack persists (IP rotation), add to firewall
sudo ufw deny from ATTACKER_SUBNET
```

---

## Runbook: Payment Failure (P1)

**Symptoms:** Miners not receiving payouts, "sendmany failed" in logs.

**Diagnosis:**
```bash
# Check wallet balance
litecoin-cli getbalance

# Check payment processor status
curl -s http://localhost:8080/api/v1/pool/stats | jq '.payments'

# Check for stuck lock
redis-cli get "lux:payment:lock"
```

**Resolution:**
```bash
# If insufficient balance
# Wait for block maturity (100 confs) or add funds

# If payment lock stuck
redis-cli del "lux:payment:lock"

# If wallet locked
litecoin-cli walletpassphrase "YOUR_PASSPHRASE" 60
```

---

## Runbook: Aux Chain Offline (P2)

**Symptoms:** Specific coin stops finding blocks, "RPC error" for that daemon.

**Diagnosis:**
```bash
# Check specific daemon
COIN_cli -rpcport=PORT getblockchaininfo

# Check AuxPoW engine
curl -s http://localhost:8080/api/v1/pool/stats | jq '.auxChains'
```

**Resolution:**
```bash
# Restart specific daemon
systemctl restart COIN_d

# If persistent, disable in .env
# COIN_ENABLED=false
# Restart pool — other chains continue mining
```

**Impact:** Only the specific aux chain stops. LTC and all other aux chains continue normally.

---

## Runbook: Disk Space Critical (P3)

**Symptoms:** Logs stop writing, PostgreSQL WAL grows, Redis RDB fails.

```bash
df -h /
du -sh /var/log/luxxpool/* | sort -h | tail -5
du -sh /var/lib/postgresql/16/main/pg_wal

# Clean logs
journalctl --vacuum-time=7d

# Vacuum PostgreSQL
sudo -u postgres vacuumdb --all --analyze

# Rotate pool logs
find /var/log/luxxpool -name "*.log" -mtime +7 -delete
```

---

## Escalation Matrix

| Scenario | On-Call Action | Escalate To |
|----------|---------------|-------------|
| Pool process won't start | Check logs, restart | Server admin |
| Litecoin daemon corrupted | Reindex, monitor | Blockchain ops |
| Database corruption | Restore from backup | DBA |
| DDoS attack | UFW block, contact ISP | Network admin |
| Block withholding detected | Review L2 fingerprint data | Security review |
| Payment discrepancy | Audit Redis balances vs DB | Finance review |

## Monitoring Checklist (every 6 hours)

- [ ] Pool hashrate within expected range
- [ ] Reject rate < 2%
- [ ] All active aux chains synced
- [ ] Redis memory < 80% of limit
- [ ] PostgreSQL connections < 80% of max
- [ ] Disk usage < 80%
- [ ] No P0/P1 alerts in last 6 hours
- [ ] Latest block found within expected timeframe
