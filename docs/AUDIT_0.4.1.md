# LUXXPOOL v0.4.1 — Critical Audit Report

## VERDICT: v0.4.0 WOULD NOT FUNCTION. Zero shares accepted.

### BUG 1 — SHOWSTOPPER: previousblockhash byte order mismatch

**File:** `src/pool/shareProcessor.js` line 179
**What happens:**
- `mining.notify` sends prevHash to miner as `reverseHex(template.previousblockhash)` (little-endian)
- Miner builds its header using this reversed prevHash
- Pool validation in `_buildBlockHeader()` uses `template.previousblockhash` (big-endian, NOT reversed)
- The 80-byte headers differ → Scrypt hashes differ → **every share rejected as low difficulty**

**Impact:** 100% share rejection. Pool appears online but no miner earns anything.

### BUG 2 — SHOWSTOPPER: buildCoinbase uses wrong template

**File:** `src/blockchain/blockTemplate.js` line 130
**What happens:**
- `buildCoinbase()` always uses `this.currentTemplate`
- When validating a share for jobId "abc123", the template may have updated to a new block
- The coinbase built during validation differs from what the miner used
- Merkle root mismatches → header hash mismatches → **shares rejected**

**Impact:** All shares for any job older than the current template are rejected.
At 1-second polling, a miner submitting shares every 15 seconds has a ~93% chance
of the template having changed. Nearly all shares fail.

### BUG 3 — SHOWSTOPPER: merkle branches from wrong template

**File:** `src/pool/shareProcessor.js` line 165-167
**What happens:**
- `_buildBlockHeader()` calls `this.templateManager._buildStratumJob()` to get merkle branches
- `_buildStratumJob()` uses `this.currentTemplate` (same root cause as Bug 2)
- Wrong merkle branches → wrong merkle root → wrong header → wrong hash

**Impact:** Same as Bug 2. Compounding failure.

### BUG 4 — MEDIUM: Redis double-prefixing

**What happens:**
- ioredis constructor has `keyPrefix: 'lux:'` which auto-prefixes ALL commands
- shareProcessor manually prepends `'lux:'` to key names
- Actual Redis keys become `lux:lux:round:123:shares` instead of `lux:round:123:shares`
- API reads use ioredis (auto-prefix) but look for `round:123:shares` → gets `lux:round:123:shares`
- shareProcessor writes to `lux:lux:round:123:shares`
- **Data is written to different keys than data is read from**

**Impact:** API shows 0 shares, 0 stats. Payment processor reads empty round data.
Miners work but never get paid.

### BUG 5 — MINOR: validJobs stores template but not precomputed job data

The validJobs Map stores `{ template, createdAt }` but not the coinbase parts or
merkle branches that were sent to miners. This forces recalculation during validation,
which is both slow and (due to Bugs 2-3) uses the wrong template.

## FIXES REQUIRED FOR v0.4.1

1. Store full precomputed job data in validJobs (coinbase1, coinbase2, merkle branches)
2. `_buildBlockHeader()` must use the STORED job data, not rebuild from current template
3. Reverse `previousblockhash` in header construction to match what miner received
4. Remove ioredis keyPrefix OR remove manual prefix in shareProcessor/redisDedup
