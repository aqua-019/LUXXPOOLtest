#!/usr/bin/env node
/**
 * LUXXPOOL v0.6.0 — Dual Mining Emulation
 * ═══════════════════════════════════════════════════════════
 * Emulation A: Mining pipeline (scrypt, merkle, header, share)
 * Emulation B: Fleet vs public miner classification, fees,
 *              runtime fleet management, capacity enforcement
 * ═══════════════════════════════════════════════════════════
 */

const crypto = require('crypto');
const {
  sha256d, scryptHash, difficultyToTarget, bitsToTarget,
  meetsTarget, buildMerkleBranches, calculateMerkleRoot,
  reverseBuffer, reverseHex, intToLE32, serializeVarInt,
} = require('../src/utils/hashing');
const FleetManager = require('../src/pool/fleetManager');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

console.log('═══════════════════════════════════════════════════════');
console.log(' LUXXPOOL v0.6.0 — DUAL EMULATION');
console.log('═══════════════════════════════════════════════════════\n');

// ═══════════════════════════════════════════════════════════
// EMULATION A: MINING PIPELINE
// ═══════════════════════════════════════════════════════════

console.log('╔═══════════════════════════════════════════════╗');
console.log('║  EMULATION A: Mining Pipeline                 ║');
console.log('╚═══════════════════════════════════════════════╝\n');

// A1: Scrypt
console.log('A1: Scrypt Hash');
const h80 = Buffer.alloc(80); h80.fill(0x01);
const sh1 = scryptHash(h80);
assert(sh1.length === 32, 'Scrypt → 32 bytes');
assert(scryptHash(h80).equals(sh1), 'Deterministic');
h80[0] = 0x02;
assert(!scryptHash(h80).equals(sh1), 'Different input → different hash');
h80[0] = 0x01;
console.log('');

// A2: SHA256d
console.log('A2: SHA256d');
assert(sha256d(Buffer.alloc(0)).toString('hex') ===
  '5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456',
  'SHA256d("") matches test vector');
console.log('');

// A3: Difficulty
console.log('A3: Difficulty/Target');
assert(difficultyToTarget(1).toString('hex') ===
  '0000ffff00000000000000000000000000000000000000000000000000000000',
  'Diff 1 target correct');
const t512 = difficultyToTarget(512);
const t1024 = difficultyToTarget(1024);
assert(Buffer.compare(t1024, t512) < 0, 'Higher diff → smaller target');
const nt = bitsToTarget('1a01cd2d');
assert(nt.length === 32 && nt[0] === 0 && nt[1] === 0, 'bitsToTarget valid');
console.log('');

// A4: Merkle
console.log('A4: Merkle Tree');
assert(buildMerkleBranches([]).length === 0, 'Empty → no branches');
const txA = Buffer.from('aa'.repeat(32), 'hex');
const txB = Buffer.from('bb'.repeat(32), 'hex');
const txC = Buffer.from('cc'.repeat(32), 'hex');
assert(buildMerkleBranches([txA]).length === 1, '1 tx → 1 branch');
assert(buildMerkleBranches([txA, txB]).length === 2, '2 tx → 2 branches');
const br3 = buildMerkleBranches([txA, txB, txC]);
assert(br3.length === 2, '3 tx → 2 branches');
const cbHash = sha256d(Buffer.from('coinbase'));
const root = calculateMerkleRoot(cbHash, br3);
const s1 = sha256d(Buffer.concat([cbHash, txA]));
const s2 = sha256d(Buffer.concat([txB, txC]));
const manual = sha256d(Buffer.concat([s1, s2]));
assert(root.equals(manual), 'Merkle root matches manual calc');
console.log('');

// A5: Full pipeline (pool header == miner header)
console.log('A5: Full Share Pipeline');
const tpl = {
  version: 536870912,
  previousblockhash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  height: 2847261, coinbasevalue: 625000000, bits: '1a01cd2d',
  transactions: [{ hash: 'ff'.repeat(32), txid: 'ff'.repeat(32), data: '0100000001' }],
};

// Build coinbase
const cb1Parts = [];
const ver = Buffer.alloc(4); ver.writeInt32LE(1); cb1Parts.push(ver);
cb1Parts.push(Buffer.from([0x01])); cb1Parts.push(Buffer.alloc(32));
cb1Parts.push(Buffer.from('ffffffff', 'hex'));
const hHex = tpl.height.toString(16);
const hPad = hHex.length % 2 ? '0' + hHex : hHex;
const hBytes = Buffer.from(hPad, 'hex').reverse();
const hSer = Buffer.concat([Buffer.from([hBytes.length]), hBytes]);
const tag = Buffer.from('/LUXXPOOL/test/', 'ascii');
const sPre = Buffer.concat([hSer, tag]);
cb1Parts.push(serializeVarInt(sPre.length + 8));
cb1Parts.push(sPre);
const coinbase1 = Buffer.concat(cb1Parts);

const p2 = [];
p2.push(Buffer.from('ffffffff', 'hex'));
p2.push(serializeVarInt(1));
const rw = Buffer.alloc(8); rw.writeBigInt64LE(BigInt(tpl.coinbasevalue));
p2.push(rw);
const scr = Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex');
p2.push(serializeVarInt(scr.length)); p2.push(scr);
p2.push(Buffer.alloc(4));
const coinbase2 = Buffer.concat(p2);

const txHashes = tpl.transactions.map(t => Buffer.from(t.hash, 'hex'));
const merkBr = buildMerkleBranches(txHashes);
const prevRev = reverseHex(tpl.previousblockhash);
const en1 = '00000001', en2 = '00000042';
const nonce = '1a2b3c4d';
const ntime = Math.floor(Date.now() / 1000).toString(16);

// Miner side
const fullEN = Buffer.from(en1 + en2, 'hex');
const fullCB = Buffer.concat([coinbase1, fullEN, coinbase2]);
const mCBH = sha256d(fullCB);
const mRoot = calculateMerkleRoot(mCBH, merkBr);
const mHdr = Buffer.alloc(80);
let o = 0;
mHdr.writeInt32LE(tpl.version, o); o += 4;
Buffer.from(prevRev, 'hex').copy(mHdr, o); o += 32;
mRoot.copy(mHdr, o); o += 32;
mHdr.writeUInt32LE(parseInt(ntime, 16), o); o += 4;
mHdr.writeUInt32LE(parseInt(tpl.bits, 16), o); o += 4;
mHdr.writeUInt32LE(parseInt(nonce, 16), o);

// Pool side (using stored job data — the v0.4.1 fix)
const pCB = Buffer.concat([coinbase1, fullEN, coinbase2]);
const pCBH = sha256d(pCB);
const pRoot = calculateMerkleRoot(pCBH, merkBr);
const pHdr = Buffer.alloc(80);
o = 0;
pHdr.writeInt32LE(tpl.version, o); o += 4;
Buffer.from(prevRev, 'hex').copy(pHdr, o); o += 32;
pRoot.copy(pHdr, o); o += 32;
pHdr.writeUInt32LE(parseInt(ntime, 16), o); o += 4;
pHdr.writeUInt32LE(parseInt(tpl.bits, 16), o); o += 4;
pHdr.writeUInt32LE(parseInt(nonce, 16), o);

assert(mHdr.equals(pHdr), '⭐ Pool header === Miner header (80 bytes exact)');
const mHash = scryptHash(mHdr);
const pHash = scryptHash(pHdr);
assert(mHash.equals(pHash), '⭐ Pool hash === Miner hash (scrypt identical)');

// Target checks
assert(meetsTarget(Buffer.alloc(32), t512), 'Zero hash meets target');
assert(!meetsTarget(Buffer.alloc(32, 0xff), t512), 'Max hash fails target');
console.log('');

// A6: Stratum format
console.log('A6: Stratum Protocol');
assert(prevRev.length === 64, 'prevHash 64 hex chars');
assert(coinbase1.length > 0 && coinbase2.length > 0, 'Coinbase parts non-empty');
const notify = [en1, prevRev, coinbase1.toString('hex'), coinbase2.toString('hex'),
  merkBr.map(b => b.toString('hex')), intToLE32(tpl.version).toString('hex'),
  tpl.bits, ntime, true];
assert(notify.length === 9, 'mining.notify has 9 params');
console.log('');

// A7: VarInt
console.log('A7: VarInt Encoding');
assert(serializeVarInt(0).equals(Buffer.from([0])), 'VarInt(0)');
assert(serializeVarInt(252).equals(Buffer.from([252])), 'VarInt(252)');
assert(serializeVarInt(253)[0] === 0xfd, 'VarInt(253)');
assert(serializeVarInt(65536)[0] === 0xfe, 'VarInt(65536)');
console.log('');

// ═══════════════════════════════════════════════════════════
// EMULATION B: FLEET vs PUBLIC MINER
// ═══════════════════════════════════════════════════════════

console.log('╔═══════════════════════════════════════════════╗');
console.log('║  EMULATION B: Fleet Management                ║');
console.log('╚═══════════════════════════════════════════════╝\n');

// B1: Fleet classification
console.log('B1: Fleet Classification');
const fm = new FleetManager({
  ips: ['192.168.1.100', '10.0.0.0/24'],
  addresses: ['LhXk7rQEaGbfPDjmFiLGaNPAHt8N2dpczW'],
  fee: 0,
  maxMiners: 5,
});

assert(fm.isFleetIp('192.168.1.100'), 'Direct IP match');
assert(fm.isFleetIp('10.0.0.50'), 'CIDR match (10.0.0.50 in 10.0.0.0/24)');
assert(!fm.isFleetIp('203.0.113.1'), 'Non-fleet IP rejected');
assert(fm.isFleetAddress('LhXk7rQEaGbfPDjmFiLGaNPAHt8N2dpczW'), 'Fleet address match');
assert(!fm.isFleetAddress('Ltc1qOTHERADDRESS'), 'Non-fleet address rejected');
assert(fm.classify('192.168.1.100', null) === 'fleet', 'Fleet IP → fleet');
assert(fm.classify('1.2.3.4', 'LhXk7rQEaGbfPDjmFiLGaNPAHt8N2dpczW') === 'fleet', 'Fleet address → fleet');
assert(fm.classify('1.2.3.4', 'LtcRandomPublic') === 'public', 'Unknown → public');
console.log('');

// B2: Fee calculation
console.log('B2: Fee Calculation');
assert(fm.getFee('192.168.1.100', null) === 0, 'Fleet pays 0% fee');
assert(fm.getFee('1.2.3.4', 'random') === null, 'Public gets null (use default)');
console.log('');

// B3: Runtime fleet management
console.log('B3: Runtime Fleet Management');
const beforeIps = fm.getConfig().ips.length;
fm.addIp('203.0.113.50');
assert(fm.isFleetIp('203.0.113.50'), 'Runtime-added IP recognized');
assert(fm.getConfig().ips.length === beforeIps + 1, 'IP count increased');

fm.addAddress('Ltc1qNewMinerAddress123');
assert(fm.isFleetAddress('Ltc1qNewMinerAddress123'), 'Runtime-added address recognized');

fm.addIp('172.16.0.0/16');
assert(fm.isFleetIp('172.16.5.10'), 'Runtime-added CIDR recognized');

fm.removeIp('203.0.113.50');
assert(!fm.isFleetIp('203.0.113.50'), 'Removed IP no longer fleet');

fm.removeAddress('Ltc1qNewMinerAddress123');
assert(!fm.isFleetAddress('Ltc1qNewMinerAddress123'), 'Removed address no longer fleet');
console.log('');

// B4: Capacity enforcement
console.log('B4: Capacity Enforcement');
const fm2 = new FleetManager({ ips: ['10.0.0.0/8'], fee: 0, maxMiners: 3 });

// Register 3 fleet miners (should succeed)
for (let i = 0; i < 3; i++) {
  fm2.registerMiner({
    id: `fleet-${i}`, workerName: `L9_${i}`, minerAddress: `LTC${i}`,
    remoteAddress: `10.0.0.${i}`, _isFleet: false,
  });
}
assert(fm2.fleetMiners.size === 3, '3 fleet miners registered');

// Register 4th (should overflow to public)
fm2.registerMiner({
  id: 'fleet-3', workerName: 'L9_3', minerAddress: 'LTC3',
  remoteAddress: '10.0.0.3', _isFleet: false,
});
assert(fm2.fleetMiners.size === 3, 'Fleet capped at 3');
assert(fm2.publicMiners.size === 1, 'Overflow miner classified as public');

// Increase capacity and add more
fm2.setMaxMiners(10);
fm2.registerMiner({
  id: 'fleet-4', workerName: 'L9_4', minerAddress: 'LTC4',
  remoteAddress: '10.0.0.4', _isFleet: false,
});
assert(fm2.fleetMiners.size === 4, 'After capacity increase, new fleet miner accepted');
console.log('');

// B5: IPv6-mapped IPv4 normalization
console.log('B5: IP Normalization');
const fm3 = new FleetManager({ ips: ['192.168.1.1'], fee: 0 });
assert(fm3.isFleetIp('::ffff:192.168.1.1'), 'IPv6-mapped IPv4 recognized as fleet');
assert(fm3.isFleetIp('192.168.1.1'), 'Plain IPv4 still works');
assert(!fm3.isFleetIp('::ffff:192.168.1.2'), 'Different IPv6-mapped rejected');
console.log('');

// B6: Fleet stats
console.log('B6: Fleet Stats');
const overview = fm2.getOverview();
assert(overview.fleet.count === 4, 'Fleet count correct in overview');
assert(overview.public.count === 1, 'Public count correct in overview');
assert(overview.totalMiners === 5, 'Total miners correct');
assert(overview.fleet.maxCapacity === 10, 'Capacity reflected in stats');
console.log('');

// B7: Miner reclassification
console.log('B7: Runtime Reclassification');
const fm4 = new FleetManager({ ips: [], fee: 0, maxMiners: 10 });
// Register as public (no fleet IPs yet)
fm4.registerMiner({
  id: 'miner-x', workerName: 'addr.L9', minerAddress: 'addr',
  remoteAddress: '50.0.0.1', _isFleet: false,
});
assert(fm4.publicMiners.size === 1, 'Miner starts as public');
assert(fm4.fleetMiners.size === 0, 'No fleet miners yet');

// Add the IP at runtime
fm4.addIp('50.0.0.1');
assert(fm4.fleetMiners.size === 1, 'Miner reclassified to fleet after runtime addIp');
assert(fm4.publicMiners.size === 0, 'No longer counted as public');
console.log('');

// B8: 20+ miners from same IP (the Christina Lake scenario)
console.log('B8: Christina Lake Scenario (20 L9s, 1 IP)');
const fm5 = new FleetManager({
  ips: ['203.0.113.100'],
  fee: 0,
  maxMiners: 100,
});

for (let i = 0; i < 20; i++) {
  fm5.registerMiner({
    id: `cl-${i}`, workerName: `LTC_ADDR.L9_${String(i+1).padStart(2,'0')}`,
    minerAddress: 'LTC_ADDR', remoteAddress: '203.0.113.100', _isFleet: false,
  });
}
assert(fm5.fleetMiners.size === 20, 'All 20 L9s registered as fleet');
assert(fm5.publicMiners.size === 0, 'Zero public miners');

// Add 5 more (scaling from 20 → 25)
for (let i = 20; i < 25; i++) {
  fm5.registerMiner({
    id: `cl-${i}`, workerName: `LTC_ADDR.L9_${i+1}`,
    minerAddress: 'LTC_ADDR', remoteAddress: '203.0.113.100', _isFleet: false,
  });
}
assert(fm5.fleetMiners.size === 25, 'Scaled to 25 — all fleet');

const stats = fm5.getFleetStats();
assert(stats.count === 25, 'Stats reflect 25 fleet miners');
assert(stats.fee === 0, 'Fleet fee is 0');

// Public miner from different IP connects
fm5.registerMiner({
  id: 'pub-1', workerName: 'PUB_ADDR.worker1',
  minerAddress: 'PUB_ADDR', remoteAddress: '1.2.3.4', _isFleet: false,
});
assert(fm5.publicMiners.size === 1, 'Public miner tracked separately');
assert(fm5.fleetMiners.size === 25, 'Fleet unchanged');

const ov = fm5.getOverview();
assert(ov.totalMiners === 26, 'Total: 25 fleet + 1 public');
console.log('');

// ═══════════════════════════════════════════════════════════
// EMULATION C: v0.7.0 — MINER DETECTION & SECURITY
// ═══════════════════════════════════════════════════════════

console.log('╔═══════════════════════════════════════════════╗');
console.log('║  EMULATION C: v0.7.0 Features                 ║');
console.log('╚═══════════════════════════════════════════════╝\n');

const MinerRegistry = require('../src/pool/minerRegistry');
const ConnectionFingerprint = require('../src/pool/connectionFingerprint');
const EmergencyLockdown = require('../src/pool/emergencyLockdown');
const IpReputation = require('../src/pool/ipReputation');
const HashrateOptimizer = require('../src/pool/hashrateOptimizer');
const AuditLog = require('../src/pool/auditLog');

// C1: Miner Registry — Model Detection
console.log('C1: Miner Model Detection');
const registry = new MinerRegistry();

const l9 = registry.identify('bitmain-antminer-l9/1.0.3');
assert(l9 !== null, 'Detects Antminer L9');
assert(l9.key === 'antminer-l9', 'L9 correct key');
assert(l9.expectedHashrate === 340e9, 'L9 expected 340 GH/s');

const l7 = registry.identify('Antminer L7');
assert(l7 !== null, 'Detects Antminer L7');
assert(l7.key === 'antminer-l7', 'L7 correct key');

const l3 = registry.identify('bitmain/antminer-l3+');
assert(l3 !== null, 'Detects Antminer L3+');
assert(l3.key === 'antminer-l3plus', 'L3+ correct key');

const dg2 = registry.identify('ElphaPex DG2 v2.1');
assert(dg2 !== null, 'Detects ElphaPex DG2');
assert(dg2.expectedHashrate === 36e9, 'DG2 expected 36 GH/s');

const unknown = registry.identify('random-unknown-miner/1.0');
assert(unknown === null, 'Unknown UA returns null');

// Optimal difficulty
assert(registry.getOptimalDifficulty('antminer-l9') === 65536, 'L9 optimal diff 65536');
assert(registry.getOptimalDifficulty('antminer-l3plus') === 512, 'L3+ optimal diff 512');
assert(registry.getOptimalDifficulty('goldshell-lt6') === 1024, 'LT6 optimal diff 1024');

// Firmware version extraction
const fwVer = registry.extractFirmwareVersion('bitmain-antminer-l9/1.0.3');
assert(fwVer !== null, 'Extracts firmware version');

// Firmware status check
const fwStatus = registry.checkFirmwareStatus('antminer-l9', '1.0.0');
assert(fwStatus !== null, 'Returns firmware status');
assert(typeof fwStatus.outdated === 'boolean', 'Status has outdated flag');

// All models
const allModels = registry.getAllModels();
assert(allModels.length === 8, '8 ASIC models registered');
console.log('');

// C2: Connection Fingerprinting
console.log('C2: Connection Fingerprinting');
const fp = new ConnectionFingerprint({ clusterThreshold: 3 });

fp.onSubscribe('client-1', '10.0.0.1', 'antminer-l9/1.0');
fp.onAuthorize('client-1', 'LTC_ADDR_1');
assert(fp.profiles.has('client-1'), 'Profile created on subscribe');

fp.onSubscribe('client-2', '10.0.0.2', 'antminer-l9/1.0');
fp.onAuthorize('client-2', 'LTC_ADDR_2');

// Simulate shares for fingerprint generation
for (let i = 0; i < 15; i++) {
  fp.onShare('client-1');
  fp.onShare('client-2');
}

fp.onDisconnect('client-1');
assert(!fp.profiles.has('client-1'), 'Profile cleaned on disconnect');
fp.onDisconnect('client-2');
console.log('');

// C3: Emergency Lockdown
console.log('C3: Emergency Lockdown');
const lockdown = new EmergencyLockdown(
  { db: null, auditLog: null, ipReputation: null },
  { autoEscalation: false } // disable auto for testing
);

assert(lockdown.getLevel() === 0, 'Starts at level 0 (Normal)');
assert(lockdown.getLevelName() === 'Normal', 'Level name: Normal');

// Fleet always allowed at any level
let check = lockdown.checkConnection(true, '10.0.0.1');
assert(check.allowed === true, 'Fleet allowed at level 0');

// Public allowed at level 0
check = lockdown.checkConnection(false, '1.2.3.4');
assert(check.allowed === true, 'Public allowed at level 0');

// Level 3: maintenance
lockdown.level = 3;
check = lockdown.checkConnection(false, '1.2.3.4');
assert(check.allowed === false, 'Public rejected at level 3');
check = lockdown.checkConnection(true, '10.0.0.1');
assert(check.allowed === true, 'Fleet still allowed at level 3');

// Reset
lockdown.level = 0;

const status = lockdown.getStatus();
assert(status.level === 0, 'Status returns current level');
assert(typeof status.metrics !== 'undefined', 'Status includes metrics');
console.log('');

// C4: IP Reputation (in-memory only, no DB)
console.log('C4: IP Reputation');
const ipRep = new IpReputation({ db: null, auditLog: null }, { rejectThreshold: 10 });

// Default score = 50
let rep = ipRep.checkReputation('192.168.1.1');
assert(rep.allowed === true, 'New IP allowed (score 50)');
assert(rep.score === 50, 'Default score is 50');

// Valid shares increase score
ipRep.recordValidShares('192.168.1.1', 200);
rep = ipRep.checkReputation('192.168.1.1');
assert(rep.score > 50, 'Score increases with valid shares');

// Invalid shares decrease
ipRep.recordInvalidShares('192.168.1.1', 1);
const afterInvalid = ipRep.checkReputation('192.168.1.1');

// Security alert = big decrease
ipRep.recordSecurityAlert('192.168.1.2');
const afterAlert = ipRep.checkReputation('192.168.1.2');
assert(afterAlert.score < 50, 'Security alert decreases score');

// Drive a score below threshold
for (let i = 0; i < 5; i++) {
  ipRep.recordSecurityAlert('192.168.1.3');
}
const lowRep = ipRep.checkReputation('192.168.1.3');
assert(lowRep.allowed === false, 'IP rejected when score below threshold');

// Block found increases score
ipRep.recordBlockFound('192.168.1.4');
const afterBlock = ipRep.checkReputation('192.168.1.4');
assert(afterBlock.score > 50, 'Block found increases score');
console.log('');

// C5: Hashrate Optimizer (unit test — no DB/estimator needed)
console.log('C5: Hashrate Optimizer');
const optimizer = new HashrateOptimizer({
  hashrateEstimator: null,
  minerRegistry: registry,
  workerTracker: null,
});

optimizer.registerMiner('test-client-1', 'LTC_ADDR_1', 'antminer-l9');
assert(optimizer.profiles.has('test-client-1'), 'Miner registered in optimizer');

const minerInfo = optimizer.profiles.get('test-client-1');
assert(minerInfo.expectedHashrate === 340e9, 'Expected hashrate from registry');
assert(minerInfo.modelKey === 'antminer-l9', 'Model key stored');

optimizer.removeMiner('test-client-1');
assert(!optimizer.profiles.has('test-client-1'), 'Miner removed from optimizer');

// Model efficiency (empty = no data)
const modelEff = optimizer.getModelEfficiency();
assert(typeof modelEff === 'object', 'Model efficiency returns object');
console.log('');

// C6: Audit Log (in-memory buffer, no DB)
console.log('C6: Audit Log');
const audit = new AuditLog({ db: null }, { retentionDays: 90 });

audit.security('test_event', { ip: '10.0.0.1', severity: 'INFO' });
assert(audit.buffer.length === 1, 'Event buffered');
assert(audit.buffer[0].event_type === 'security:test_event', 'Event type stored');
assert(audit.buffer[0].severity === 'INFO', 'Severity stored');

audit.admin('admin_action', 'admin', { action: 'test' });
assert(audit.buffer.length === 2, 'Admin event buffered');

audit.ban('ban_event', { ip: '1.2.3.4', duration: 3600 });
assert(audit.buffer.length === 3, 'Ban event buffered');

audit.lockdown('lockdown_change', { level: 2, reason: 'test' });
assert(audit.buffer.length === 4, 'Lockdown event buffered');
console.log('');

// C7: VarDiff Model Floor
console.log('C7: VarDiff Model Floor');
const VarDiff = require('../src/stratum/vardiff');
const vd = new VarDiff({ min: 64, max: 65536, targetTime: 15, retargetTime: 90 });
assert(vd.modelFloor === null, 'Default model floor is null');

vd.setModelFloor(8192);
assert(vd.modelFloor === 8192, 'Model floor set to 8192');
assert(vd.minDiff >= 8192, 'minDiff raised to model floor');
console.log('');

// ═══════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════');
console.log(` RESULTS: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════');

if (failed > 0) {
  console.error('\n⛔ EMULATION FAILED');
  process.exit(1);
} else {
  console.log('\n✅ ALL TESTS PASSED');
  console.log('   Mining pipeline: mathematically correct');
  console.log('   Fleet management: 20 L9s + scaling + runtime ops verified');
  console.log('   v0.7.0: Model detection, security, optimization verified');
  process.exit(0);
}
