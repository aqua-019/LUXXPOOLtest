/**
 * LUXXPOOL v0.7.2 — EMULATION C: Critical Path Tests
 * Address validation · Security engine · Redis keys · VarDiff
 * No external dependencies — pure emulation
 */

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

console.log('═══════════════════════════════════════════════════════');
console.log(' LUXXPOOL v0.6.0 — EMULATION C');
console.log(' Critical Path: Address · Security · Redis · VarDiff');
console.log('═══════════════════════════════════════════════════════\n');

// ═══════════════════════════════════════════════════════
// C1: ADDRESS VALIDATION (bech32 checksum, base58)
// ═══════════════════════════════════════════════════════

console.log('C1: Address Validation\n');

const { validateAddress, bech32Decode, base58Decode } = require('../src/utils/addressCodec');

test('Valid P2PKH address (L-prefix)', () => {
  // Generate a valid Base58Check P2PKH address (version 0x30)
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update('luxxpool-test-p2pkh').digest().slice(0, 20);
  const payload = Buffer.concat([Buffer.from([0x30]), hash]);
  const check = crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(payload).digest()
  ).digest().slice(0, 4);
  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt('0x' + Buffer.concat([payload, check]).toString('hex'));
  let addr = '';
  while (num > 0n) { addr = BASE58[Number(num % 58n)] + addr; num /= 58n; }
  for (const b of payload) { if (b === 0) addr = '1' + addr; else break; }

  const result = validateAddress(addr);
  assert(result.valid, `Expected valid, got: ${result.error}`);
  assert(result.type === 'p2pkh', `Expected p2pkh, got: ${result.type}`);
});

test('Valid P2SH address (M-prefix)', () => {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update('luxxpool-test-p2sh').digest().slice(0, 20);
  const payload = Buffer.concat([Buffer.from([0x32]), hash]);
  const check = crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(payload).digest()
  ).digest().slice(0, 4);
  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt('0x' + Buffer.concat([payload, check]).toString('hex'));
  let addr = '';
  while (num > 0n) { addr = BASE58[Number(num % 58n)] + addr; num /= 58n; }
  for (const b of payload) { if (b === 0) addr = '1' + addr; else break; }

  const result = validateAddress(addr);
  assert(result.valid, `Expected valid, got: ${result.error}`);
  assert(result.type === 'p2sh', `Expected p2sh, got: ${result.type}`);
});

test('Valid bech32 v0 address (ltc1q...)', () => {
  // ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9 is the test vector
  const result = validateAddress('ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9');
  assert(result.valid, `Expected valid, got: ${result.error}`);
  assert(result.type === 'bech32', `Expected bech32, got: ${result.type}`);
});

test('Reject empty string', () => {
  const result = validateAddress('');
  assert(!result.valid, 'Expected invalid');
  assert(result.error === 'Empty address', `Wrong error: ${result.error}`);
});

test('Reject null/undefined', () => {
  const result = validateAddress(null);
  assert(!result.valid, 'Expected invalid');
});

test('Reject truncated address', () => {
  const result = validateAddress('ltc1q');
  assert(!result.valid, 'Expected invalid for truncated address');
});

test('Reject invalid bech32 characters', () => {
  const result = validateAddress('ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7k1234'); // bad chars at end
  assert(!result.valid, 'Expected invalid for bad checksum');
});

test('Reject Bitcoin address (wrong network)', () => {
  // Bitcoin bech32 starts with bc1, not ltc1 — validateAddress only accepts ltc1
  const result = validateAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  // This should fail because it starts with bc1 not ltc1, and base58 decode would fail
  assert(!result.valid, 'Expected invalid for Bitcoin address');
});

// ═══════════════════════════════════════════════════════
// C2: REDIS KEYS (centralized key builder)
// ═══════════════════════════════════════════════════════

console.log('\nC2: Redis Keys\n');

const RedisKeys = require('../src/utils/redisKeys');
const keys = new RedisKeys('lux:');

test('Round shares key format', () => {
  assert(keys.roundShares(12345) === 'lux:round:12345:shares');
});

test('Worker shares key format', () => {
  assert(keys.workerShares('Laddr123') === 'lux:worker:Laddr123:shares');
});

test('Dedup key includes all 5 components', () => {
  const k = keys.dedup('job1', 'en1', 'en2', 'ntime', 'nonce');
  assert(k === 'lux:dedup:job1:en1:en2:ntime:nonce');
  assert(k.split(':').length === 7); // prefix + dedup + 5 components
});

test('Pending balance key format', () => {
  assert(keys.pendingBalance('Laddr') === 'lux:balance:Laddr:pending');
});

test('Custom prefix works', () => {
  const custom = new RedisKeys('pool:');
  assert(custom.totalShares() === 'pool:stats:totalShares');
});

test('No double prefix', () => {
  const k = keys.poolHashrate();
  assert(!k.includes('lux:lux:'), 'Double prefix detected');
});

// ═══════════════════════════════════════════════════════
// C3: SECURITY ENGINE — Unit Tests (9-layer, v0.7.0+)
// ═══════════════════════════════════════════════════════

console.log('\nC3: Security Engine (9-layer)\n');

const { SecurityEngine } = require('../src/pool/securityEngine');

const mockDb = { query: async () => ({ rows: [] }) };
const mockBanning = {
  ban: () => {},
  isBanned: () => false,
  recordViolation: () => {},
};
const mockRedis = {
  get: async () => null,
  set: async () => 'OK',
  pipeline: () => ({ exec: async () => [] }),
};

const secEngine = new SecurityEngine(
  {
    transport: { requireTls: false },
    protocol: { maxMessageBytes: 2048, maxWorkerLength: 96, maxPasswordLength: 64 },
    auth: {},
    fingerprint: { minShares: 500, bwhThreshold: 0.01, staleLimit: 0.20 },
    behavior: { maxSharesPerSec: 10, maxNtimeDeviation: 300, maxAddressesPerIp: 3, maxHashrateOscillation: 5 },
    rateLimit: { maxConnPerIp: 5, maxConnPerFleetIp: 100, maxShareRatePerMin: 600, maxConnRatePerMin: 30 },
    identity: { maxWorkersPerAddress: 50 },
    reputation: { banThreshold: 100, flagThreshold: 250 },
    audit: { maxLocalLog: 10000 },
  },
  { redis: mockRedis, db: mockDb, banningManager: mockBanning }
);

test('SecurityEngine has all 9 layers', () => {
  assert(secEngine.layers, 'Missing layers object');
  assert(secEngine.layers.transport, 'Missing L1: transport');
  assert(secEngine.layers.protocol, 'Missing L2: protocol');
  assert(secEngine.layers.auth, 'Missing L3: auth');
  assert(secEngine.layers.fingerprint, 'Missing L4: fingerprint');
  assert(secEngine.layers.behavior, 'Missing L5: behavior');
  assert(secEngine.layers.rateLimit, 'Missing L6: rate limit');
  assert(secEngine.layers.identity, 'Missing L7: identity');
  assert(secEngine.layers.reputation, 'Missing L8: reputation');
  assert(secEngine.layers.audit, 'Missing L9: audit');
});

test('L1: Transport layer accepts plaintext', () => {
  const result = secEngine.layers.transport.check({ encrypted: false });
  assert(result.result === 'pass', `Expected pass, got ${result.result}`);
});

test('L2: Protocol layer rejects oversized messages', () => {
  const result = secEngine.layers.protocol.check(Buffer.alloc(3000).toString(), '127.0.0.1');
  assert(result.result === 'reject', `Expected reject for oversized message, got ${result.result}`);
});

test('L4: Fingerprint layer tracks shares', () => {
  const addr = 'LtestFP' + Date.now();
  secEngine.layers.fingerprint.recordShare(addr, 512, false);
  const profile = secEngine.layers.fingerprint.getProfile(addr);
  assert(profile, 'Fingerprint profile should exist after share');
  assert(profile.total > 0, 'Total shares should be > 0');
});

test('L6: Rate limiter tracks connections per IP', () => {
  const rl = secEngine.layers.rateLimit;
  assert(rl.activeConns instanceof Map, 'activeConns should be a Map');
});

test('L8: Reputation engine initializes', () => {
  const rep = secEngine.layers.reputation;
  assert(typeof rep.getScore === 'function' || typeof rep.scores !== 'undefined', 'Reputation layer should have scoring');
});

test('L9: Audit trail buffer exists', () => {
  const audit = secEngine.layers.audit;
  assert(audit.localLog instanceof Array, 'Audit should have localLog array');
});

// ═══════════════════════════════════════════════════════
// C4: VARDIFF
// ═══════════════════════════════════════════════════════

console.log('\nC4: VarDiff\n');

const VarDiffManager = require('../src/stratum/vardiff');

const vd = new VarDiffManager({
  min: 64,
  max: 65536,
  targetTime: 15,
  retargetTime: 0.001, // immediate retarget for testing
});

test('Constructor sets min/max correctly', () => {
  assert(vd.minDiff === 64, `Expected min 64, got ${vd.minDiff}`);
  assert(vd.maxDiff === 65536, `Expected max 65536, got ${vd.maxDiff}`);
});

test('First share returns null (no adjustment yet)', () => {
  const vd2 = new VarDiffManager({ min: 64, max: 65536, targetTime: 15, retargetTime: 0 });
  const result = vd2.recordShare();
  assert(result === null, 'First share should not trigger retarget');
});

test('Target time stored correctly', () => {
  assert(vd.targetTime === 15, `Expected target 15, got ${vd.targetTime}`);
});

test('Internal ratio calculation is bounded', () => {
  // _calculateNewDifficulty returns a ratio clamped to [0.25, 4]
  const vd3 = new VarDiffManager({ min: 64, max: 65536, targetTime: 15, retargetTime: 0 });
  vd3.shareTimes = [1, 1, 1]; // Very fast shares
  vd3.lastRetarget = 0;
  const ratio = vd3._calculateNewDifficulty();
  assert(ratio <= 4, `Ratio ${ratio} exceeds 4x cap`);
  assert(ratio >= 0.25, `Ratio ${ratio} below 0.25x floor`);
});

test('Slow shares produce ratio < 1', () => {
  const vd4 = new VarDiffManager({ min: 64, max: 65536, targetTime: 15, retargetTime: 0 });
  vd4.shareTimes = [60, 60, 60]; // Very slow (4x target)
  vd4.lastRetarget = 0;
  const ratio = vd4._calculateNewDifficulty();
  assert(ratio < 1, `Expected ratio < 1 for slow shares, got ${ratio}`);
});

// ═══════════════════════════════════════════════════════
// C5: HASHING FUNDAMENTALS
// ═══════════════════════════════════════════════════════

console.log('\nC5: Hashing Edge Cases\n');

const { sha256d, reverseBuffer, reverseHex, serializeVarInt, buildMerkleBranches } = require('../src/utils/hashing');

test('reverseBuffer round-trip', () => {
  const buf = Buffer.from('0102030405', 'hex');
  const reversed = reverseBuffer(buf);
  const restored = reverseBuffer(reversed);
  assert(buf.equals(restored), 'Double reverse should restore original');
});

test('reverseHex round-trip', () => {
  const hex = 'aabbccdd';
  assert(reverseHex(reverseHex(hex)) === hex, 'Double reverse should restore');
});

test('Merkle branches for 4 transactions', () => {
  const txids = [
    Buffer.alloc(32, 1),
    Buffer.alloc(32, 2),
    Buffer.alloc(32, 3),
    Buffer.alloc(32, 4),
  ];
  const branches = buildMerkleBranches(txids);
  assert(branches.length === 3, `Expected 3 branches for 4 tx, got ${branches.length}`);
});

test('Merkle branches for 5 transactions', () => {
  const txids = Array.from({ length: 5 }, (_, i) => Buffer.alloc(32, i + 1));
  const branches = buildMerkleBranches(txids);
  assert(branches.length === 3, `Expected 3 branches for 5 tx, got ${branches.length}`);
});

test('Merkle branches scale logarithmically', () => {
  const tx8 = Array.from({ length: 8 }, (_, i) => Buffer.alloc(32, i + 1));
  const tx16 = Array.from({ length: 16 }, (_, i) => Buffer.alloc(32, i + 1));
  const b8 = buildMerkleBranches(tx8);
  const b16 = buildMerkleBranches(tx16);
  assert(b16.length === b8.length + 1, `Expected ${b8.length + 1} for 16 tx, got ${b16.length}`);
});

test('VarInt large values', () => {
  const vi = serializeVarInt(70000);
  assert(vi.length === 5, `Expected 5 bytes for 70000, got ${vi.length}`);
  assert(vi[0] === 0xfe, 'Should use 0xFE prefix for 32-bit');
});

// ═══════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════

console.log('\n═══════════════════════════════════════════════════════');
console.log(` EMULATION C RESULTS: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════');
if (failed === 0) {
  console.log('\n✅ ALL EMULATION C TESTS PASSED');
} else {
  console.log(`\n❌ ${failed} TESTS FAILED`);
  process.exit(1);
}
