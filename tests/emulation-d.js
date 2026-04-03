/**
 * LUXXPOOL v0.8.1 — EMULATION D: Full Pool Lifecycle
 * 40 fleet L9 miners + 3 public + 1 solo — classification,
 * PPLNS payouts, solo fee, payment retry, fee transparency,
 * auto-wallet registration, share audit.
 * No external dependencies — pure emulation.
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

// ═══════════════════════════════════════════════════════
// Real classes under test
// ═══════════════════════════════════════════════════════

const FleetManager = require('../src/pool/fleetManager');
const PaymentProcessor = require('../src/payment/paymentProcessor');
const VarDiffManager = require('../src/stratum/vardiff');

// ═══════════════════════════════════════════════════════
// D1: 40 FLEET L9 MINERS — CIDR CLASSIFICATION
// ═══════════════════════════════════════════════════════

console.log('\nD1: Fleet Registration — 40 L9 Miners\n');

const fm = new FleetManager({
  ips: ['10.0.0.0/24'],
  addresses: [],
  fee: 0,
  maxMiners: 100,
});

// Register 40 fleet miners from IPs within CIDR range
const fleetClients = [];
for (let i = 1; i <= 40; i++) {
  const client = {
    id: `fleet-${i}`,
    workerName: `Lfleet${String(i).padStart(2, '0')}.L9-${i}`,
    minerAddress: `Lfleet${String(i).padStart(2, '0')}aaaaaaaaaaaaaaaaaaaaaa`,
    remoteAddress: `10.0.0.${(i % 254) + 1}`,
    _isFleet: false,
  };
  fm.registerMiner(client);
  fleetClients.push(client);
}

test('40 L9 miners registered as fleet', () => {
  assert(fm.fleetMiners.size === 40, `Expected 40 fleet, got ${fm.fleetMiners.size}`);
});

test('All 40 flagged _isFleet=true', () => {
  const allFleet = fleetClients.every(c => c._isFleet === true);
  assert(allFleet, 'Not all miners flagged as fleet');
});

test('No fleet miners in public pool', () => {
  assert(fm.publicMiners.size === 0, `Expected 0 public, got ${fm.publicMiners.size}`);
});

test('Fleet fee is 0%', () => {
  assert(fm.fleetFee === 0, `Expected fee 0, got ${fm.fleetFee}`);
});

// ═══════════════════════════════════════════════════════
// D2: FLEET CAPACITY — ALL 40 FIT, NONE DOWNGRADED
// ═══════════════════════════════════════════════════════

console.log('\nD2: Fleet Capacity Enforcement\n');

test('Fleet at 40 of 100 capacity — no overflow', () => {
  const overview = fm.getOverview();
  assert(overview.fleet.count === 40, `Fleet count ${overview.fleet.count} !== 40`);
  assert(overview.fleet.maxCapacity === 100, `Max capacity ${overview.fleet.maxCapacity} !== 100`);
});

test('41st miner from non-fleet IP goes to public', () => {
  const pubClient = {
    id: 'extra-pub',
    workerName: 'Lextra.w1',
    minerAddress: 'Lextraaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    remoteAddress: '203.0.113.50',
    _isFleet: false,
  };
  fm.registerMiner(pubClient);
  assert(pubClient._isFleet === false, 'Non-fleet IP should be public');
  assert(fm.publicMiners.size === 1, 'Should have 1 public miner');
  // Cleanup
  fm.publicMiners.delete('extra-pub');
});

// ═══════════════════════════════════════════════════════
// D3: PUBLIC MINERS — CORRECT CLASSIFICATION
// ═══════════════════════════════════════════════════════

console.log('\nD3: Public Miner Classification\n');

const publicClients = [];
for (let i = 1; i <= 3; i++) {
  const client = {
    id: `pub-${i}`,
    workerName: `Lpub${String(i).padStart(2, '0')}.rig${i}`,
    minerAddress: `Lpub${String(i).padStart(2, '0')}bbbbbbbbbbbbbbbbbbbbbbbb`,
    remoteAddress: `203.0.113.${10 + i}`,
    _isFleet: false,
  };
  fm.registerMiner(client);
  publicClients.push(client);
}

test('3 public miners registered correctly', () => {
  assert(fm.publicMiners.size === 3, `Expected 3 public, got ${fm.publicMiners.size}`);
});

test('Public miners flagged _isFleet=false', () => {
  const allPublic = publicClients.every(c => c._isFleet === false);
  assert(allPublic, 'Some public miners incorrectly flagged as fleet');
});

test('Fleet + public = 43 total', () => {
  const overview = fm.getOverview();
  assert(overview.fleet.count + overview.public.count === 43,
    `Total ${overview.fleet.count + overview.public.count} !== 43`);
});

// ═══════════════════════════════════════════════════════
// D4: SOLO MINER — CORRECT CLASSIFICATION
// ═══════════════════════════════════════════════════════

console.log('\nD4: Solo Miner Classification\n');

const soloClient = {
  id: 'solo-1',
  workerName: 'Lsolo01.solo',
  minerAddress: 'Lsolo01cccccccccccccccccccccccccc',
  remoteAddress: '198.51.100.1',
  _isFleet: false,
  isSolo: true,
  soloFee: 0.01,
};
fm.registerMiner(soloClient);

test('Solo miner classified as public (non-fleet IP)', () => {
  assert(soloClient._isFleet === false, 'Solo should not be fleet');
});

test('Solo miner has isSolo=true and soloFee=0.01', () => {
  assert(soloClient.isSolo === true, 'Missing isSolo');
  assert(soloClient.soloFee === 0.01, `soloFee ${soloClient.soloFee} !== 0.01`);
});

// ═══════════════════════════════════════════════════════
// D5: FLEET CAPACITY SCALING (40 → 60)
// ═══════════════════════════════════════════════════════

console.log('\nD5: Runtime Fleet Scaling\n');

test('Scale fleet capacity 100 → 60 at runtime', () => {
  fm.setMaxMiners(60);
  assert(fm.maxFleetMiners === 60, `Max miners ${fm.maxFleetMiners} !== 60`);
});

test('Existing 40 fleet miners still registered after resize', () => {
  assert(fm.fleetMiners.size === 40, `Fleet count ${fm.fleetMiners.size} !== 40`);
});

test('Can add 20 more fleet miners up to new cap of 60', () => {
  for (let i = 41; i <= 60; i++) {
    fm.registerMiner({
      id: `fleet-${i}`,
      workerName: `Lfleet${i}.L9-${i}`,
      minerAddress: `Lfleet${i}dddddddddddddddddddddddd`,
      remoteAddress: `10.0.0.${(i % 254) + 1}`,
      _isFleet: false,
    });
  }
  assert(fm.fleetMiners.size === 60, `Fleet count ${fm.fleetMiners.size} !== 60`);
});

test('61st fleet miner overflows to public', () => {
  const overflow = {
    id: 'fleet-overflow',
    workerName: 'Loverflow.w1',
    minerAddress: 'Loverfloweeeeeeeeeeeeeeeeeeeeeeee',
    remoteAddress: '10.0.0.200',
    _isFleet: false,
  };
  fm.registerMiner(overflow);
  assert(overflow._isFleet === false, 'Overflow should be public');
  assert(fm.publicMiners.has('fleet-overflow'), 'Overflow should be in publicMiners');
});

// ═══════════════════════════════════════════════════════
// D6: PPLNS — FLEET 0% FEE, PUBLIC 2% FEE
// ═══════════════════════════════════════════════════════

console.log('\nD6: PPLNS Fee Calculation\n');

// Create a minimal PaymentProcessor to test _calculatePayments()
const mockRpc = { sendMany: async () => 'txid_mock_001', getBlockCount: async () => 50100 };
const mockDb = { query: async () => ({ rows: [], rowCount: 0 }) };
const mockRedis = {
  get: async () => null,
  set: async () => 'OK',
  del: async () => 1,
  incrbyfloat: async () => '0',
  pipeline: () => ({ hincrby: () => {}, incr: () => {}, set: () => {}, exec: async () => [] }),
};

const pp = new PaymentProcessor(mockRpc, mockDb, mockRedis, {
  pplnsWindow: 100,
  poolFee: 0.02,
  minPayout: 0.001,
  fleetAddresses: new Set([
    'Lfleet01aaaaaaaaaaaaaaaaaaaaaa',
    'Lfleet02aaaaaaaaaaaaaaaaaaaaaa',
  ]),
}, null);

// Simulate shares: fleet 80%, public 20%
const shares = {
  'Lfleet01aaaaaaaaaaaaaaaaaaaaaa': 60000,  // 60%
  'Lfleet02aaaaaaaaaaaaaaaaaaaaaa': 20000,  // 20%
  'Lpub01bbbbbbbbbbbbbbbbbbbbbbbb': 15000,  // 15%
  'Lpub02bbbbbbbbbbbbbbbbbbbbbbbb': 5000,   // 5%
};

const block = { height: 50000, reward: 625000000, is_solo: false, address: null }; // 6.25 LTC in litoshis
const payments = pp._calculatePayments(block, shares);

test('Fleet miner 1 (60% shares) gets ~60% of reward at 0% fee', () => {
  const expected = 6.25 * 0.60; // 3.75 LTC
  const actual = payments['Lfleet01aaaaaaaaaaaaaaaaaaaaaa'];
  assert(Math.abs(actual - expected) < 0.001, `Fleet1 got ${actual}, expected ~${expected}`);
});

test('Fleet miner 2 (20% shares) gets ~20% at 0% fee', () => {
  const expected = 6.25 * 0.20; // 1.25 LTC
  const actual = payments['Lfleet02aaaaaaaaaaaaaaaaaaaaaa'];
  assert(Math.abs(actual - expected) < 0.001, `Fleet2 got ${actual}, expected ~${expected}`);
});

test('Public miner 1 (15% shares) gets ~15% minus 2% fee', () => {
  const gross = 6.25 * 0.15; // 0.9375
  const expected = gross * 0.98; // 0.91875
  const actual = payments['Lpub01bbbbbbbbbbbbbbbbbbbbbbbb'];
  assert(Math.abs(actual - expected) < 0.001, `Pub1 got ${actual}, expected ~${expected}`);
});

test('Public miner 2 (5% shares) gets ~5% minus 2% fee', () => {
  const gross = 6.25 * 0.05; // 0.3125
  const expected = gross * 0.98; // 0.30625
  const actual = payments['Lpub02bbbbbbbbbbbbbbbbbbbbbbbb'];
  assert(Math.abs(actual - expected) < 0.001, `Pub2 got ${actual}, expected ~${expected}`);
});

// ═══════════════════════════════════════════════════════
// D7: PPLNS PROPORTIONALITY
// ═══════════════════════════════════════════════════════

console.log('\nD7: PPLNS Proportionality\n');

test('Total distributed ≈ 6.25 LTC (minus public fees)', () => {
  const total = Object.values(payments).reduce((a, b) => a + b, 0);
  // Fleet gets full share (80% of 6.25 = 5.0), public gets 98% of theirs (20% of 6.25 * 0.98 = 1.225)
  const expected = 5.0 + 1.225;
  assert(Math.abs(total - expected) < 0.01, `Total ${total} !== ~${expected}`);
});

test('Fleet miners got exactly 0% fee (full proportional share)', () => {
  const fleet1 = payments['Lfleet01aaaaaaaaaaaaaaaaaaaaaa'];
  const fleet2 = payments['Lfleet02aaaaaaaaaaaaaaaaaaaaaa'];
  // Fleet share = 80% of 6.25 = 5.0 total. F1 = 60/80 * 5.0 = 3.75, F2 = 20/80 * 5.0 = 1.25
  assert(Math.abs(fleet1 + fleet2 - 5.0) < 0.001, `Fleet total ${fleet1 + fleet2} !== 5.0`);
});

// ═══════════════════════════════════════════════════════
// D8: SOLO BLOCK — FULL REWARD MINUS 1% FEE
// ═══════════════════════════════════════════════════════

console.log('\nD8: Solo Block Payout\n');

const soloBlock = {
  height: 50001,
  reward: 625000000,
  is_solo: true,
  solo_fee: 0.01,
  address: 'Lsolo01cccccccccccccccccccccccccc',
};

const soloPayments = pp._calculatePayments(soloBlock, shares);

test('Solo block pays only the solo miner', () => {
  assert(Object.keys(soloPayments).length === 1, `Expected 1 recipient, got ${Object.keys(soloPayments).length}`);
  assert('Lsolo01cccccccccccccccccccccccccc' in soloPayments, 'Solo miner not in payments');
});

test('Solo miner gets 99% of 6.25 LTC (1% fee)', () => {
  const expected = 6.25 * 0.99; // 6.1875
  const actual = soloPayments['Lsolo01cccccccccccccccccccccccccc'];
  assert(Math.abs(actual - expected) < 0.001, `Solo got ${actual}, expected ~${expected}`);
});

// ═══════════════════════════════════════════════════════
// D9: PAYMENT RETRY — FAILED → RETRIED
// ═══════════════════════════════════════════════════════

console.log('\nD9: Payment Retry\n');

// Simulate: RPC sendMany fails first time, succeeds second
let sendManyAttempts = 0;
const retryRpc = {
  sendMany: async () => {
    sendManyAttempts++;
    if (sendManyAttempts === 1) throw new Error('Wallet locked');
    return 'txid_retry_001';
  },
  getBlockCount: async () => 50200,
  call: async (method) => {
    if (method === 'getblockhash') return 'abc123def456';
    return null;
  },
  getBlock: async () => ({ confirmations: 150, hash: 'abc123def456' }),
};

// In-memory DB for retry test
const retryDbRows = {
  payments: [
    { id: 1, address: 'Lretry01', amount: 1.5, coin: 'LTC', status: 'failed', block_height: 50000 },
    { id: 2, address: 'Lretry02', amount: 0.8, coin: 'LTC', status: 'failed', block_height: 50000 },
  ],
};
const retryDb = {
  query: async (sql) => {
    // SELECT failed payments
    if (sql.includes('SELECT') && sql.includes("'failed'")) {
      return { rows: retryDbRows.payments.filter(p => p.status === 'failed'), rowCount: 0 };
    }
    // UPDATE: SET status = 'sent' (after successful sendMany)
    if (sql.includes('UPDATE') && sql.includes("SET status = 'sent'")) {
      retryDbRows.payments.forEach(p => { if (p.status === 'pending') p.status = 'sent'; });
      return { rowCount: 2 };
    }
    // UPDATE: SET status = 'pending' (before sendMany attempt)
    if (sql.includes('UPDATE') && sql.includes("SET status = 'pending'")) {
      retryDbRows.payments.forEach(p => { if (p.status === 'failed') p.status = 'pending'; });
      return { rowCount: 2 };
    }
    // UPDATE: SET status = 'failed' (revert after failed sendMany)
    if (sql.includes('UPDATE') && sql.includes("SET status = 'failed'")) {
      retryDbRows.payments.forEach(p => { if (p.status === 'pending') p.status = 'failed'; });
      return { rowCount: 2 };
    }
    // Blocks query (no confirmed blocks for retry test)
    if (sql.includes('blocks')) {
      return { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  }
};

const retryPP = new PaymentProcessor(retryRpc, retryDb, mockRedis, {
  pplnsWindow: 100, poolFee: 0.02, minPayout: 0.001,
  fleetAddresses: new Set(),
}, null);

// Run payment cycle (includes retry of failed payments)
async function testRetry() {
  await retryPP.processPayments();
}

// We'll run async tests sequentially
const asyncTests = [];

asyncTests.push(async () => {
  sendManyAttempts = 0;
  // Reset to failed state
  retryDbRows.payments.forEach(p => p.status = 'failed');

  // First retry: sendMany throws → payments revert to failed
  await retryPP._retryFailedPayments();
  assert(sendManyAttempts === 1, `Expected 1 attempt, got ${sendManyAttempts}`);
  // Payments revert to 'failed' because the mock UPDATE for 'failed' runs on catch
  const stillFailed = retryDbRows.payments.every(p => p.status === 'failed');
  assert(stillFailed, 'After first failed attempt, payments should be back to failed');

  // Second retry: sendMany succeeds (attempt #2)
  await retryPP._retryFailedPayments();
  assert(sendManyAttempts === 2, `Expected 2 attempts, got ${sendManyAttempts}`);
  const allSent = retryDbRows.payments.every(p => p.status === 'sent');
  assert(allSent, `Expected all payments sent, got: ${retryDbRows.payments.map(p => p.status)}`);
  console.log('  ✅ Failed payments retried and succeeded on second attempt');
  passed++;
});

// ═══════════════════════════════════════════════════════
// D10: FEE TRANSPARENCY LEDGER
// ═══════════════════════════════════════════════════════

console.log('\nD10: Fee Transparency Ledger\n');

test('Fee math: gross - net = fee collected', () => {
  const grossReward = 6.25;
  const netDistributed = Object.values(payments).reduce((a, b) => a + b, 0);
  const feeCollected = grossReward - netDistributed;
  // Public paid 2% on their 20% share: 6.25 * 0.20 * 0.02 = 0.025
  assert(feeCollected > 0, 'Fee should be positive');
  assert(Math.abs(feeCollected - 0.025) < 0.001, `Fee ${feeCollected} !== ~0.025`);
});

test('Fee percentage = feeAmount / grossReward', () => {
  const grossReward = 6.25;
  const netDistributed = Object.values(payments).reduce((a, b) => a + b, 0);
  const feePct = (grossReward - netDistributed) / grossReward;
  // Only 20% of miners pay 2%, so effective fee = 0.4%
  assert(feePct > 0 && feePct < 0.01, `Effective fee ${(feePct * 100).toFixed(2)}% should be ~0.4%`);
});

// ═══════════════════════════════════════════════════════
// D11: AUTO-WALLET REGISTRATION SIMULATION
// ═══════════════════════════════════════════════════════

console.log('\nD11: Auto-Wallet Registration\n');

// Simulate the auto-wallet registration logic from index.js
const walletChecked = new Set();
const walletRecords = [];
const AUX_COINS = ['DOGE', 'BELLS', 'LKY', 'PEP', 'JKC', 'DINGO', 'SHIC'];

function simulateAutoWallet(minerAddress) {
  if (walletChecked.has(minerAddress)) return;
  walletChecked.add(minerAddress);
  for (const coin of AUX_COINS) {
    walletRecords.push({ miner_address: minerAddress, coin, coin_address: null });
  }
}

// First share from fleet miner
simulateAutoWallet('Lfleet01aaaaaaaaaaaaaaaaaaaaaa');
// Second share from same miner (should not duplicate)
simulateAutoWallet('Lfleet01aaaaaaaaaaaaaaaaaaaaaa');
// First share from public miner
simulateAutoWallet('Lpub01bbbbbbbbbbbbbbbbbbbbbbbb');

test('First share creates 7 aux wallet records', () => {
  const fleet1Wallets = walletRecords.filter(r => r.miner_address === 'Lfleet01aaaaaaaaaaaaaaaaaaaaaa');
  assert(fleet1Wallets.length === 7, `Expected 7, got ${fleet1Wallets.length}`);
});

test('Second share from same miner does not duplicate', () => {
  assert(walletRecords.length === 14, `Expected 14 total (7+7), got ${walletRecords.length}`);
});

test('All wallet records have coin_address=null (pending registration)', () => {
  const allNull = walletRecords.every(r => r.coin_address === null);
  assert(allNull, 'Some records have non-null coin_address');
});

test('All 7 enabled aux coins covered', () => {
  const coins = walletRecords.filter(r => r.miner_address === 'Lfleet01aaaaaaaaaaaaaaaaaaaaaa').map(r => r.coin);
  for (const c of AUX_COINS) {
    assert(coins.includes(c), `Missing coin ${c}`);
  }
});

// ═══════════════════════════════════════════════════════
// D12: SHARE AUDIT — VALID + REJECTED + STALE
// ═══════════════════════════════════════════════════════

console.log('\nD12: Share Audit Log\n');

// Simulate share recording with status
const shareLog = [];

function recordShare(worker, address, difficulty, height, status, reason) {
  shareLog.push({ worker, address, difficulty, height, status, rejection_reason: reason || null });
}

// Valid shares
for (let i = 0; i < 10; i++) {
  recordShare('Lfleet01.L9', 'Lfleet01aa', 8192, 50000, 'valid', null);
}
// Rejected share (bad nonce)
recordShare('Lpub01.rig1', 'Lpub01bb', 512, 50000, 'rejected', 'bad nonce');
// Stale share (job not found)
recordShare('Lpub02.rig1', 'Lpub02bb', 256, 49999, 'stale', 'job not found');
// Rejected share (low difficulty)
recordShare('Lpub03.rig1', 'Lpub03bb', 128, 50000, 'rejected', 'low difficulty');

test('Share log contains valid, rejected, and stale entries', () => {
  const valid = shareLog.filter(s => s.status === 'valid').length;
  const rejected = shareLog.filter(s => s.status === 'rejected').length;
  const stale = shareLog.filter(s => s.status === 'stale').length;
  assert(valid === 10, `Expected 10 valid, got ${valid}`);
  assert(rejected === 2, `Expected 2 rejected, got ${rejected}`);
  assert(stale === 1, `Expected 1 stale, got ${stale}`);
});

test('Rejected shares have rejection_reason', () => {
  const rejected = shareLog.filter(s => s.status === 'rejected');
  assert(rejected.every(s => s.rejection_reason !== null), 'Missing rejection reason');
});

test('Valid shares have null rejection_reason', () => {
  const valid = shareLog.filter(s => s.status === 'valid');
  assert(valid.every(s => s.rejection_reason === null), 'Valid shares should have null reason');
});

// ═══════════════════════════════════════════════════════
// D13: VARDIFF — DIFFICULTY ADJUSTMENT
// ═══════════════════════════════════════════════════════

console.log('\nD13: VarDiff Adjustment\n');

const vd = new VarDiffManager({ min: 64, max: 65536, targetTime: 15, retargetTime: 0 });

test('L9 model floor sets minimum difficulty', () => {
  vd.setModelFloor(8192);
  assert(vd.minDiff >= 8192, `minDiff ${vd.minDiff} should be >= 8192`);
});

test('VarDiff adjusts down for slow shares', () => {
  const vd2 = new VarDiffManager({ min: 64, max: 65536, targetTime: 15, retargetTime: 0 });
  vd2.shareTimes = [60, 60, 60]; // 4x too slow
  vd2.lastRetarget = 0;
  const ratio = vd2._calculateNewDifficulty();
  assert(ratio < 1, `Expected ratio < 1 for slow shares, got ${ratio}`);
});

test('VarDiff adjusts up for fast shares', () => {
  const vd3 = new VarDiffManager({ min: 64, max: 65536, targetTime: 15, retargetTime: 0 });
  vd3.shareTimes = [3, 3, 3]; // 5x too fast
  vd3.lastRetarget = 0;
  const ratio = vd3._calculateNewDifficulty();
  assert(ratio > 1, `Expected ratio > 1 for fast shares, got ${ratio}`);
});

// ═══════════════════════════════════════════════════════
// RUN ASYNC TESTS + SUMMARY
// ═══════════════════════════════════════════════════════

(async () => {
  console.log('\nD9: Payment Retry (async)\n');
  for (const fn of asyncTests) {
    try {
      await fn();
    } catch (err) {
      console.log(`  ❌ Async test failed: ${err.message}`);
      failed++;
    }
  }

  console.log(`
═══════════════════════════════════════════════════════
 EMULATION D RESULTS: ${passed} passed, ${failed} failed
═══════════════════════════════════════════════════════
`);

  if (failed > 0) {
    console.log(`❌ ${failed} TESTS FAILED`);
    process.exit(1);
  } else {
    console.log('✅ ALL EMULATION D TESTS PASSED');
  }
})();
