# LUXXPOOL — Production Deployment Notes

This file collects operator-facing deployment guidance that lives outside the source tree. Keep entries short, actionable, and dated against the release that introduced them.

## sendmany minconf=1 (v0.8.3, M-2)

The pool now passes `minconf=1` as the third positional argument to every `sendmany` payout call. Without it the wallet defaults to `minconf=0`, meaning it can spend a UTXO from a block we just mined — and if that block is orphaned, the payout transaction becomes invalid and miners aren't paid until the next reorg recovery.

**Wallet compatibility.** The third positional `minconf` argument is supported on both Litecoin Core legacy and descriptor wallets back to 0.21. If you're running a fork or pre-0.21 daemon, verify with `litecoin-cli help sendmany`. Newer Core versions also accept named arguments (`{"minconf": 1}`); we use positional for backwards safety.

**No operator action required** if you're on standard Litecoin Core ≥ 0.21.

## Hardening: rpcauth migration (v0.8.3)

**Why.** `docker/docker-compose.prod.yml` currently passes `-rpcpassword=${LTC_PASS}` on the `litecoind` command line and the healthcheck. Both are visible to anyone who can `ps aux`, `docker top luxxpool-litecoind`, or read kernel audit logs. A read-only host-level intrusion is enough to leak the wallet RPC password.

**Goal.** Keep `LTC_PASS` plaintext in the pool container's `.env` (the pool needs it to make outgoing RPC calls), but stop passing it as a command-line argument to the daemon. The daemon authenticates via a salted hash (`rpcauth=`) loaded from a config file, while the pool keeps the matching plaintext password.

### Step 1 — Generate `rpcauth` and a fresh `LTC_PASS`

The Litecoin Core source tree ships `share/rpcauth/rpcauth.py`; alternatively, run this one-liner on any host with Python 3:

```bash
python3 -c "
import os, hmac, hashlib
user='luxxpool_rpc'
pwd=os.urandom(16).hex()
salt=os.urandom(16).hex()
h=hmac.new(salt.encode(), pwd.encode(), hashlib.sha256).hexdigest()
print(f'rpcauth={user}:{salt}\${h}')
print(f'PASSWORD (paste into .env as LTC_PASS): {pwd}')
"
```

Save both outputs. The `rpcauth=` line goes into the daemon config; the plaintext password goes into `.env` so the pool can authenticate when it calls the daemon.

### Step 2 — Create `docker/litecoin.conf` (NOT committed)

Add a config file mounted into the container — never commit this file (it carries the rpcauth hash):

```ini
server=1
txindex=1
rpcauth=luxxpool_rpc:<salt>$<hash>
rpcallowip=172.28.0.0/16
rpcbind=0.0.0.0
rpcport=9332
zmqpubhashblock=tcp://0.0.0.0:28332
maxconnections=64
dbcache=1024
```

Add to `.gitignore`:

```
docker/litecoin.conf
```

### Step 3 — Compose snippet

Replace the existing `litecoind` service `command:` block with a config-file mount. Diff:

```yaml
   litecoind:
-    image: uphold/litecoin-core:latest
+    image: uphold/litecoin-core@sha256:<DIGEST>     # pin to a specific digest
     container_name: luxxpool-litecoind
     restart: always
-    command: >
-      -server=1
-      -txindex=1
-      -rpcuser=luxxpool_rpc
-      -rpcpassword=${LTC_PASS}
-      -rpcallowip=172.28.0.0/16
-      -rpcbind=0.0.0.0
-      -rpcport=9332
-      -zmqpubhashblock=tcp://0.0.0.0:28332
-      -maxconnections=64
-      -dbcache=1024
+    # Config + secrets live in litecoin.conf (gitignored, mounted read-only).
     volumes:
       - ltc-data:/home/litecoin/.litecoin
+      - ./litecoin.conf:/home/litecoin/.litecoin/litecoin.conf:ro
     ports:
       - "127.0.0.1:9332:9332"
       - "127.0.0.1:28332:28332"
     healthcheck:
-      test: ["CMD", "litecoin-cli", "-rpcuser=luxxpool_rpc", "-rpcpassword=${LTC_PASS}", "getblockcount"]
+      test: ["CMD-SHELL", "litecoin-cli -conf=/home/litecoin/.litecoin/litecoin.conf getblockcount > /dev/null"]
```

### Step 4 — Verify

After `docker compose up -d litecoind`:

```bash
docker top luxxpool-litecoind                 # no -rpcpassword on any line
docker exec luxxpool-litecoind \
  litecoin-cli -conf=/home/litecoin/.litecoin/litecoin.conf getblockcount
docker logs luxxpool                          # pool still authenticates RPC
```

`docker top` must not show the password anywhere. The pool keeps using `LTC_PASS` from `.env` for outgoing RPC; only the daemon side switched to the salted hash.

This change is intentionally **not** in the v0.8.3 hardening PR — pinning a fresh password and image digest belongs in the OVH provisioning runbook so it's done once at deployment time without churning the repo.
