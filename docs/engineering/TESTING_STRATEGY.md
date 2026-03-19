# LUXXPOOL v0.6.0 — Testing Strategy

## Current Coverage

| Subsystem | Tests | Status |
|-----------|-------|--------|
| Scrypt hashing | 3 | ✅ Emulation A |
| SHA256d | 1 | ✅ Emulation A |
| Difficulty/target | 3 | ✅ Emulation A |
| Merkle tree | 5 | ✅ Emulation A |
| Full share pipeline | 4 | ✅ Emulation A |
| Stratum protocol | 3 | ✅ Emulation A |
| VarInt encoding | 4 | ✅ Emulation A |
| Fleet classification | 8 | ✅ Emulation B |
| Fleet fee calculation | 2 | ✅ Emulation B |
| Fleet runtime ops | 6 | ✅ Emulation B |
| Fleet capacity | 4 | ✅ Emulation B |
| Fleet IP normalization | 3 | ✅ Emulation B |
| Fleet stats | 4 | ✅ Emulation B |
| Fleet reclassification | 4 | ✅ Emulation B |
| Christina Lake scenario | 8 | ✅ Emulation B |
| **Total** | **62** | **100% pass** |

## Coverage Gaps

| Subsystem | Lines | Risk | Priority |
|-----------|-------|------|----------|
| Address validation (bech32 checksum) | 257 | HIGH — rejects valid miners | P0 |
| Security manager (3 layers) | 548 | HIGH — false positives ban miners | P0 |
| Payment processor | 313 | HIGH — financial accuracy | P0 |
| API routes | 795 | MEDIUM — data exposure | P1 |
| Worker tracker | 218 | LOW — monitoring only | P2 |
| Health monitor | 155 | LOW — monitoring only | P2 |
| Block watcher | 178 | MEDIUM — confirmation tracking | P1 |
| VarDiff | 101 | MEDIUM — miner experience | P1 |
| AuxPoW engine | 455 | HIGH — merged mining revenue | P0 |
| Multi-coin payment | 260 | HIGH — financial accuracy | P0 |
| Redis keys | 51 | LOW — pure functions | P2 |
| Profit estimator | 87 | LOW — display only | P3 |

## Test Expansion Plan

### Phase 1: Critical Path (P0) — Emulation C

**C1: Address Validation (8 tests)**
- Valid P2PKH (L-prefix)
- Valid P2SH (M-prefix)
- Valid bech32 v0 (ltc1q...)
- Valid bech32m v1 (ltc1p...)
- Reject invalid checksum
- Reject wrong network (bc1...)
- Reject empty string
- Reject truncated address

**C2: Security Manager (12 tests)**
- L1: Cookie generation returns unique per client
- L1: Cookie verification accepts valid cookie
- L1: Cookie verification rejects tampered cookie
- L2: Normal miner not flagged after 1000 shares
- L2: BWH pattern detected (shares but no blocks over threshold)
- L2: Block found reduces BWH suspicion
- L3: Share flood detected (>10/sec)
- L3: Ntime drift detected (>300s)
- L3: VarDiff gaming detected (>16x swing)
- L3: Sybil detected (>3 addresses from 1 IP)
- Fleet miners bypass L2 checks
- Fleet miners bypass L3 checks

**C3: Payment Processor (8 tests)**
- PPLNS share calculation for 2 miners
- Fee applied correctly (2% pool fee)
- Fleet miners pay 0% fee
- Minimum payout threshold enforced
- Balance accumulation for sub-threshold amounts
- Batch payment construction
- Round marked as paid after processing
- Concurrent payment lock prevents double-processing

**C4: AuxPoW Engine (6 tests)**
- Aux chain registration
- Merkle branch construction for aux block
- Chain ID mapping correct for each aux coin
- Aux block submission format
- Failed aux chain doesn't affect others
- Aux block found event emission

### Phase 2: Important (P1) — Emulation D

**D1: API Routes (10 tests)**
- GET /api/v1/pool/stats returns valid JSON
- GET /api/v1/miner/:address validates address format
- POST /api/v1/fleet/ip rejects non-IP input
- GET /api/v1/security/events returns array
- Rate limiting returns 429 after threshold
- Unknown coin returns 400
- Missing parameters return 400
- Fleet endpoints reject non-local requests
- CORS headers present on responses
- Health endpoint returns 200

**D2: VarDiff (6 tests)**
- Difficulty increases when shares arrive too fast
- Difficulty decreases when shares arrive too slow
- Difficulty stays within min/max bounds
- Retarget only happens after retarget interval
- New connection gets starting difficulty
- Variance tolerance prevents oscillation

**D3: Block Watcher (4 tests)**
- Immature block tracked on discovery
- Confirmation count updates
- Orphaned block detected and marked
- Mature block triggers payment round

### Phase 3: Nice to Have (P2/P3)

- Worker tracker lifecycle (connect → shares → disconnect)
- Health monitor daemon polling
- Redis key builder (unit tests on each key pattern)
- Profit estimator calculations
- UX copy string completeness (no undefined keys)

## Test Architecture

```
tests/
├── emulation.js          ← Existing: 62 tests (mining + fleet)
├── emulation-c.js        ← Phase 1: address, security, payment, auxpow (34 tests)
├── emulation-d.js        ← Phase 2: API, vardiff, blockwatcher (20 tests)
└── run-all.js            ← Runner: executes A + B + C + D, reports total
```

All tests are self-contained emulations — no running daemons, no network, no external dependencies. They import modules directly and test with synthetic data.

## Target: v0.7.0

| Metric | Current (v0.6.0) | Target (v0.7.0) |
|--------|-------------------|------------------|
| Total tests | 62 | 116 |
| Subsystems covered | 2 (mining, fleet) | 8+ |
| Critical path coverage | ~40% | ~90% |
| Financial path coverage | 0% | ~80% |
