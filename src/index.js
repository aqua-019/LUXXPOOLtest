/**
 * ═══════════════════════════════════════════════════════════════
 *  LUXXPOOL — Scrypt Multi-Coin Merged Mining Pool
 *  Main Process — Full System Orchestrator
 *
 *  ALL SYSTEMS WIRED:
 *    Stratum (pool/SSL/solo) → BanningManager → SecurityEngine
 *    → ShareProcessor → HashrateEstimator → BlockTemplateManager
 *    → AuxPowEngine → BlockWatcher → PaymentProcessors → API
 *
 *  Features:
 *    - Nine-layer SecurityEngine (v0.7.0+)
 *    - Mining cookies generated on every connection
 *    - Share fingerprinting active on every share
 *    - Behavioral anomaly engine active on every share
 *    - Security auto-ban escalation connected
 *    - Redis-backed share deduplication
 *    - HashrateEstimator wired to stratum client objects
 *    - Security API routes mounted
 *    - Graceful degradation for Redis/DB failures
 * ═══════════════════════════════════════════════════════════════
 */

const config = require('../config');
const { createLogger } = require('./utils/logger');
const { initDatabase, runMigrations, query } = require('./utils/database');
const Redis = require('ioredis');

const RpcClient             = require('./blockchain/rpcClient');
const BlockTemplateManager  = require('./blockchain/blockTemplate');
const BlockNotifier         = require('./blockchain/blockNotifier');
const AuxPowEngine          = require('./blockchain/auxpow');
const ZmqBlockNotifier      = require('./blockchain/zmqNotifier');
const { StratumServer }     = require('./stratum/server');
const StratumSSL            = require('./stratum/ssl');
const SoloMiningServer      = require('./stratum/solo');
const ShareProcessor        = require('./pool/shareProcessor');
const BanningManager        = require('./pool/banningManager');
const { SecurityEngine }    = require('./pool/securityEngine');
const FleetManager          = require('./pool/fleetManager');
const PaymentProcessor      = require('./payment/paymentProcessor');
const MultiCoinPaymentProcessor = require('./payment/multiCoinPayment');
const { createApiServer }   = require('./api/server');
const StatsCollector        = require('./monitoring/statsCollector');
const HashrateEstimator     = require('./monitoring/hashrateEstimator');
const WorkerTracker         = require('./monitoring/workerTracker');
const DaemonHealthMonitor   = require('./monitoring/healthMonitor');
const BlockConfirmationWatcher = require('./workers/blockWatcher');
const { SCRYPT_COINS }      = require('../config/coins');
const { STRATUM, OPS }      = require('./ux/copy');
const RedisKeys             = require('./utils/redisKeys');

// v0.7.0: New modules
const MinerRegistry          = require('./pool/minerRegistry');
const FirmwareTracker        = require('./pool/firmwareTracker');
const HashrateOptimizer      = require('./pool/hashrateOptimizer');
const IpReputation           = require('./pool/ipReputation');
const ConnectionFingerprint  = require('./pool/connectionFingerprint');
const EmergencyLockdown      = require('./pool/emergencyLockdown');
const AuditLog               = require('./pool/auditLog');
const PoolWebSocketServer    = require('./api/websocket');

const { version }           = require('../package.json');

const log = createLogger('main');

const AUX_SYMBOLS = ['DOGE', 'BELLS', 'LKY', 'PEP', 'JKC', 'DINGO', 'SHIC', 'TRMP', 'CRC'];

function loadAuxChainConfigs() {
  const configs = {};
  for (const sym of AUX_SYMBOLS) {
    if (process.env[`${sym}_ENABLED`] === 'true') {
      configs[sym] = {
        host:     process.env[`${sym}_HOST`] || '127.0.0.1',
        port:     parseInt(process.env[`${sym}_PORT`] || SCRYPT_COINS[sym]?.defaultPort || '0'),
        user:     process.env[`${sym}_USER`] || 'luxxpool_rpc',
        password: process.env[`${sym}_PASS`] || '',
        address:  process.env[`${sym}_ADDRESS`] || '',
      };
    }
  }
  return configs;
}

async function main() {
  log.info(`
  ╔═══════════════════════════════════════════════════════╗
  ║           LUXXPOOL Mining Pool v${version}                 ║
  ║    Scrypt Multi-Coin Merged Mining (AuxPoW)           ║
  ║    Full Security Engine · Optimized Pool Core         ║
  ╚═══════════════════════════════════════════════════════╝
  `);

  config.validate();

  // ─── Infrastructure ─────────────────────────────────────
  log.info('Initializing PostgreSQL...');
  const db = initDatabase();
  await runMigrations();
  const dbQuery = { query };

  log.info('Connecting to Redis...');
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    db: config.redis.db,
    // NOTE: keyPrefix REMOVED in v0.4.1 — shareProcessor and redisDedup
    // manually prefix keys. Having ioredis also prefix causes double-prefixing
    // (e.g., 'lux:lux:round:...' instead of 'lux:round:...').
    retryStrategy: (times) => Math.min(times * 200, 5000),
    lazyConnect: true,
    enableOfflineQueue: true,
  });

  let redisConnected = false;
  try {
    await redis.connect();
    redisConnected = true;
    log.info('Redis connected');
  } catch (err) {
    log.warn({ err: err.message }, 'Redis offline — operating in degraded mode');
  }

  const redisKeys = new RedisKeys(config.redis.keyPrefix || 'lux:');

  // ─── Litecoin Daemon ────────────────────────────────────
  log.info('Connecting to Litecoin daemon...');
  const ltcRpc = new RpcClient({
    host: config.litecoin.host,
    port: config.litecoin.port,
    user: config.litecoin.user,
    password: config.litecoin.password,
    coin: 'litecoin',
  });

  const ltcAlive = await ltcRpc.ping();
  if (!ltcAlive) {
    log.fatal('Cannot connect to Litecoin daemon — aborting');
    process.exit(1);
  }

  const ltcInfo = await ltcRpc.getBlockchainInfo();
  log.info({ chain: ltcInfo.chain, blocks: ltcInfo.blocks, headers: ltcInfo.headers }, 'Litecoin daemon connected');

  // Block startup if daemon is still performing initial block download
  if (ltcInfo.initialblockdownload) {
    const pct = ((ltcInfo.blocks / ltcInfo.headers) * 100).toFixed(2);
    log.fatal(
      { blocks: ltcInfo.blocks, headers: ltcInfo.headers, progress: `${pct}%` },
      'Litecoin daemon is still syncing — pool cannot start until sync completes'
    );
    process.exit(1);
  }

  // ─── Auxiliary Chains ───────────────────────────────────
  const auxConfigs = loadAuxChainConfigs();
  const auxRpcClients = {};
  const allRpcClients = { LTC: ltcRpc };

  for (const [symbol, conf] of Object.entries(auxConfigs)) {
    const rpc = new RpcClient({
      host: conf.host, port: conf.port,
      user: conf.user, password: conf.password,
      coin: symbol.toLowerCase(),
    });
    const alive = await rpc.ping();
    if (alive) {
      auxRpcClients[symbol] = rpc;
      allRpcClients[symbol] = rpc;
      log.info({ coin: symbol }, `✅ ${symbol} daemon connected`);
    } else {
      log.warn({ coin: symbol }, `⚠️  ${symbol} daemon offline`);
    }
  }

  // ─── AuxPoW Engine ──────────────────────────────────────
  const auxPowEngine = new AuxPowEngine(auxConfigs);
  await auxPowEngine.start(5000);

  // ─── Block Template Manager ─────────────────────────────
  const templateManager = new BlockTemplateManager(ltcRpc, {
    fee: config.pool.fee,
    feeAddress: config.pool.feeAddress,
    auxPowEngine,
  });

  // ─── Block Notifier (ZMQ + polling fallback) ───────────
  const blockNotifier = new BlockNotifier({
    host: process.env.LTC_ZMQ_HOST || '127.0.0.1',
    port: parseInt(process.env.LTC_ZMQ_PORT || '28332'),
    enabled: process.env.LTC_ZMQ_ENABLED === 'true',
    pollIntervalMs: 1000,
    rpcClient: ltcRpc,
  });

  blockNotifier.on('newBlock', async () => {
    try {
      await templateManager.updateTemplate();
    } catch (err) {
      log.error({ err: err.message }, 'Template update on new block failed');
    }
  });

  // Merged mining: rebuild template when aux blocks change so the
  // new aux merkle root is embedded in the next coinbase scriptSig.
  auxPowEngine.on('newAuxBlock', async (symbol) => {
    try {
      await templateManager.updateTemplate();
      log.debug({ coin: symbol }, 'Template refreshed for aux block update');
    } catch (err) {
      log.error({ coin: symbol, err: err.message }, 'Template refresh on aux block failed');
    }
  });

  await blockNotifier.start();

  // Also poll every 5s as safety net (ZMQ is primary, poll is backup)
  templateManager.start(blockNotifier.isZMQ() ? 5000 : 1000);
  log.info({ zmq: blockNotifier.isZMQ(), pollMs: blockNotifier.isZMQ() ? 5000 : 1000 },
    `Block detection: ${blockNotifier.isZMQ() ? 'ZMQ (instant) + 5s poll backup' : 'Polling every 1s'}`
  );

  // ─── Hashrate Estimator ─────────────────────────────────
  const hashrateEstimator = new HashrateEstimator({
    windowMs: 600000,
    updateIntervalMs: 30000,
  });
  hashrateEstimator.start();

  // ─── Worker Tracker (v0.6.0) ───────────────────────────
  const workerTracker = new WorkerTracker(dbQuery, redis);
  workerTracker.start();

  // ─── Daemon Health Monitor (v0.6.0) ────────────────────
  const healthMonitor = new DaemonHealthMonitor(
    { rpcClients: allRpcClients, redis, db: dbQuery },
    30000
  );
  healthMonitor.start();

  healthMonitor.on('daemonDown', (sym, err) => {
    log.error({ coin: sym, err }, `${sym} daemon went offline`);
  });
  healthMonitor.on('daemonBehind', (sym, behind) => {
    log.warn({ coin: sym, behind }, `${sym} daemon syncing — ${behind} blocks behind`);
  });
  healthMonitor.on('redisDown', () => log.error('Redis went offline'));
  healthMonitor.on('postgresDown', () => log.error('PostgreSQL went offline'));
  healthMonitor.on('highMemory', (pct) => log.warn({ memPct: pct }, 'High memory usage'));

  // ─── Banning Manager ───────────────────────────────────
  const banningManager = new BanningManager({
    invalidPercent: config.stratum.banning.invalidPercent,
    banDuration: config.security.banDuration,
    maxConnectionsPerIp: config.security.maxConnectionsPerIp,
  }, { db: dbQuery });
  banningManager.start();

  // ═══════════════════════════════════════════════════════
  // FLEET MANAGEMENT — v0.5.1
  // Distinguishes LUXX-owned miners from public miners
  // (Moved before SecurityEngine — it's a dependency)
  // ═══════════════════════════════════════════════════════
  const fleetManager = new FleetManager({
    ips:       (process.env.FLEET_IPS || '').split(',').filter(Boolean),
    addresses: (process.env.FLEET_ADDRESSES || '').split(',').filter(Boolean),
    fee:       parseFloat(process.env.FLEET_FEE || '0'),
    maxMiners: parseInt(process.env.FLEET_MAX_MINERS || '100'),
  });

  log.info({
    fleetIps: (process.env.FLEET_IPS || '').split(',').filter(Boolean).length,
    fleetAddresses: (process.env.FLEET_ADDRESSES || '').split(',').filter(Boolean).length,
    fleetFee: parseFloat(process.env.FLEET_FEE || '0') * 100 + '%',
  }, '🏗  Fleet manager initialized');

  // ═══════════════════════════════════════════════════════
  // NINE-LAYER SECURITY ENGINE — v0.7.0
  // ═══════════════════════════════════════════════════════
  const securityEngine = new SecurityEngine(
    config.securityEngine,
    { redis, db: dbQuery, banningManager, fleetManager }
  );
  securityEngine.start();

  log.info('🛡️  Nine-layer security engine ACTIVE');

  // ═══════════════════════════════════════════════════════
  // v0.7.0: MINER MODEL DETECTION & FIRMWARE TRACKING
  // ═══════════════════════════════════════════════════════
  const minerRegistry = new MinerRegistry();

  const auditLog = new AuditLog({ db: dbQuery }, {
    retentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS || '90'),
  });
  auditLog.start();

  const ipReputation = new IpReputation(
    { db: dbQuery, auditLog },
    { rejectThreshold: parseInt(process.env.IP_REPUTATION_REJECT || '10') }
  );
  await ipReputation.start();

  const connectionFingerprint = new ConnectionFingerprint({
    clusterThreshold: parseInt(process.env.FINGERPRINT_CLUSTER_THRESHOLD || '5'),
  });
  connectionFingerprint.start();

  const emergencyLockdown = new EmergencyLockdown(
    { db: dbQuery, auditLog, ipReputation },
    { autoEscalation: process.env.LOCKDOWN_AUTO_ESCALATION !== 'false' }
  );
  emergencyLockdown.start();

  const firmwareTracker = new FirmwareTracker(
    { minerRegistry, db: dbQuery, auditLog }
  );
  firmwareTracker.start();

  const hashrateOptimizer = new HashrateOptimizer(
    { hashrateEstimator, minerRegistry, workerTracker }
  );
  hashrateOptimizer.start();

  // Wire v0.7.0 dependencies into existing security/banning
  banningManager.ipReputation = ipReputation;

  // Connection fingerprint cluster alerts → lockdown metrics
  connectionFingerprint.on('clusterDetected', (cluster) => {
    emergencyLockdown.recordSecurityAlert();
    auditLog.security('cluster_detected', {
      ...cluster,
      severity: 'WARN',
    });
  });

  // Hashrate optimizer underperformance → audit log
  hashrateOptimizer.on('underperformance', (data) => {
    auditLog.firmware('underperformance', data);
  });

  // Emergency lockdown level changes → audit log (already wired internally)
  emergencyLockdown.on('levelChanged', (data) => {
    log.warn({ level: data.level, reason: data.reason }, 'Lockdown level changed');
  });

  log.info('🔧 v0.7.0 systems initialized: MinerRegistry, FirmwareTracker, HashrateOptimizer');
  log.info('🛡️  v0.7.0 security: IpReputation, ConnectionFingerprint, EmergencyLockdown, AuditLog');

  // ─── Stratum Servers ────────────────────────────────────
  const stratumServer = new StratumServer(
    {
      host: config.stratum.host,
      port: config.stratum.port,
      difficulty: config.stratum.difficulty,
      vardiff: config.stratum.vardiff,
      maxConnectionsPerIp: config.security.maxConnectionsPerIp,
      isWhitelisted: (ip) => fleetManager.isFleetIp(ip), // v0.5.1: fleet bypasses IP limits
    },
    templateManager
  );

  const stratumSSL = new StratumSSL(stratumServer, {
    host: config.stratum.host,
    port: config.stratum.portSsl,
    certPath: config.security.sslCert,
    keyPath: config.security.sslKey,
  });

  const soloServer = new SoloMiningServer(
    {
      host: config.stratum.host,
      port: config.stratum.portSolo,
      difficulty: config.stratum.difficulty,
      soloFee: parseFloat(process.env.SOLO_FEE || '0.01'),
      vardiff: config.stratum.vardiff,
    },
    templateManager
  );

  // ─── Share Processor ────────────────────────────────────
  const shareProcessor = new ShareProcessor(
    templateManager, ltcRpc,
    { fee: config.pool.fee, feeAddress: config.pool.feeAddress },
    dbQuery, redis, redisKeys
  );

  // ═══════════════════════════════════════════════════════
  // WIRING: Connection → Fleet Check → Ban Check → Cookie
  // Fleet miners: bypass IP limits, bypass banning
  // Public miners: full security pipeline
  // ═══════════════════════════════════════════════════════

  // Pool mining connections
  stratumServer.on('subscribe', (client, agent) => {
    const isFleet = fleetManager.isFleetIp(client.remoteAddress);

    if (!isFleet) {
      // PUBLIC: full security checks

      // v0.7.0: Emergency lockdown check
      const lockdownCheck = emergencyLockdown.checkConnection(false, client.remoteAddress);
      if (!lockdownCheck.allowed) {
        emergencyLockdown.recordRejectedConnection();
        client.disconnect(lockdownCheck.reason);
        return;
      }

      // v0.7.0: IP reputation check
      const repCheck = ipReputation.checkReputation(client.remoteAddress);
      if (!repCheck.allowed) {
        emergencyLockdown.recordRejectedConnection();
        client.disconnect('low reputation');
        return;
      }

      if (banningManager.isBanned(client.remoteAddress)) {
        emergencyLockdown.recordRejectedConnection();
        client.disconnect('banned');
        return;
      }
      if (!banningManager.recordConnection(client.remoteAddress)) {
        emergencyLockdown.recordRejectedConnection();
        client.disconnect('connection flood');
        return;
      }
    }
    // FLEET: skip ban check and connection limits entirely

    // v0.7.0: Miner model detection from user-agent
    const model = minerRegistry.identify(agent);
    if (model) {
      client._minerModel = model;
      client._firmwareVersion = minerRegistry.extractFirmwareVersion(agent);

      // Set model-aware initial difficulty (L9→65536, L3+→512, etc.)
      const optimalDiff = minerRegistry.getOptimalDifficulty(model.key);
      if (optimalDiff && optimalDiff !== client.difficulty) {
        client.sendDifficulty(optimalDiff);
      }

      // Set VarDiff floor to prevent gaming
      const diffFloor = minerRegistry.getDifficultyFloor(model.key);
      if (diffFloor) {
        client.vardiff.setModelFloor(diffFloor);
      }
    }

    // v0.7.0: Connection fingerprinting
    connectionFingerprint.onSubscribe(client.id, client.remoteAddress, agent);

    // SecurityEngine L3: Issue mining cookie
    const { cookie } = securityEngine.onSubscribe(client.id);
    client._miningCookie = cookie;
    client._isFleet = isFleet;

    log.debug({ ip: client.remoteAddress, agent, fleet: isFleet, model: model?.name || 'unknown' }, 'Miner subscribed');
  });

  // Register miners on authorize (now we know their address)
  stratumServer.on('authorize', async (client, workerName) => {
    const type = fleetManager.classify(client.remoteAddress, client.minerAddress);
    client._isFleet = type === 'fleet';
    fleetManager.registerMiner(client);
    workerTracker.onConnect(client, client.userAgent || 'unknown');

    // SecurityEngine L7 (address validation) + L8 (reputation check)
    try {
      const authResult = await securityEngine.onAuthorize(client.id, workerName, client.remoteAddress);
      if (authResult.result === 'ban' || authResult.result === 'reject') {
        client.disconnect(authResult.reason);
        return;
      }
    } catch (err) {
      log.error({ err: err.message }, 'SecurityEngine onAuthorize error');
    }

    // v0.7.0: Connection fingerprint update
    connectionFingerprint.onAuthorize(client.id, client.minerAddress);

    // v0.7.0: Firmware check + advisory (sent on authorize per user preference)
    if (client._minerModel && client._firmwareVersion) {
      firmwareTracker.checkAndAdvisory(client, client._minerModel, client._firmwareVersion);
    }

    // v0.7.0: Register with hashrate optimizer
    if (client._minerModel) {
      hashrateOptimizer.registerMiner(client.id, client.minerAddress, client._minerModel.key);
    }
  });

  // Solo mining connections
  soloServer.on('authorize', (client) => {
    const isFleet = fleetManager.isFleetIp(client.remoteAddress);
    if (!isFleet) {
      if (banningManager.isBanned(client.remoteAddress)) {
        client.disconnect('banned');
        return;
      }
      if (!banningManager.recordConnection(client.remoteAddress)) {
        client.disconnect('connection flood');
        return;
      }
    }
    // SecurityEngine L3: Issue mining cookie
    const { cookie } = securityEngine.onSubscribe(client.id);
    client._miningCookie = cookie;
    client._isFleet = isFleet;
    fleetManager.registerMiner(client);
  });

  // ═══════════════════════════════════════════════════════
  // WIRING: Share Submission → Full Pipeline
  // Fleet: skip ban + anomaly checks (trusted hardware)
  // Public: ban → anomaly(L3) → share processor
  // ═══════════════════════════════════════════════════════

  async function handleShare(client, share) {
    // SecurityEngine: unified 9-layer share validation (L3, L4, L5, L6, L7)
    try {
      const secResult = await securityEngine.onShare(
        { id: client.id, ip: client.remoteAddress, address: client.minerAddress },
        {
          ...share,
          // TODO: Mining cookie anti-hijack is not yet effective. Currently
          // submittedCookie is the server-issued cookie (always matches itself).
          // For real protection, cookie bytes must be embedded in the coinbase
          // scriptSig and validated from the miner's submitted share data.
          // Stratum v1 has no protocol field for miners to return cookies.
          submittedCookie: client._miningCookie,
          isFleet: client._isFleet,
          hashrateGhps: client.hashrate,
        }
      );

      if (secResult.result === 'ban') {
        banningManager.ban(client.remoteAddress, secResult.reason);
        client.rejectShare(share.id, STRATUM.errors.SECURITY.code, secResult.reason);
        client.disconnect('security ban');
        return;
      }
      if (secResult.result === 'reject') {
        client.rejectShare(share.id, STRATUM.errors.SECURITY.code, secResult.reason);
        return;
      }
    } catch (err) {
      log.error({ err: err.message }, 'SecurityEngine onShare error');
    }

    // PASS or FLAG: proceed to share validation
    shareProcessor.processShare(client, share);
  }

  stratumServer.on('submit', handleShare);
  soloServer.on('submit', handleShare);

  // ═══════════════════════════════════════════════════════
  // WIRING: Share Results → Security + Hashrate
  // ═══════════════════════════════════════════════════════

  shareProcessor.on('validShare', (client, share, auxProof) => {
    if (!client._isFleet) {
      banningManager.recordValidShare(client.remoteAddress);
      // L4 fingerprinting now handled by SecurityEngine.onShare()
      // v0.7.0: IP reputation + fingerprint
      ipReputation.recordValidShares(client.remoteAddress, 1);
      connectionFingerprint.onShare(client.id);
    }
    hashrateEstimator.recordShare(client.id, share.difficulty, client.minerAddress);
    client.hashrate = hashrateEstimator.getWorkerHashrate(client.id);
    workerTracker.onValidShare(client, share.difficulty);
    fleetManager.updateMiner(client.id, {
      hashrate: client.hashrate,
      validShares: (fleetManager.fleetMiners.get(client.id)?.validShares || 0) + 1,
    });

    // ── Merged mining: check share against all aux chain targets ──
    if (auxProof && auxPowEngine) {
      auxPowEngine.checkAuxChains(
        auxProof.hash,
        auxProof.headerBuffer,
        auxProof.coinbaseHex,
        auxProof.merkleBranches,
        client
      ).catch(err => log.error({ err: err.message }, 'AuxPoW check error'));
    }
  });

  shareProcessor.on('invalidShare', (client, share, reason) => {
    workerTracker.onInvalidShare(client);
    if (!client._isFleet) {
      banningManager.recordInvalidShare(client.remoteAddress);
      // L5 behavioral analysis now handled by SecurityEngine.onShare()
      // v0.7.0: IP reputation + lockdown metrics
      ipReputation.recordInvalidShares(client.remoteAddress, 1);
      emergencyLockdown.recordInvalidShare();
    }
  });

  shareProcessor.on('staleShare', (client) => {
    workerTracker.onStaleShare(client);
    if (!client._isFleet) {
      banningManager.recordInvalidShare(client.remoteAddress);
    }
  });

  shareProcessor.on('duplicateShare', (client) => {
    if (!client._isFleet) {
      banningManager.recordViolation(client.remoteAddress, 'duplicate share');
    }
  });

  // ═══════════════════════════════════════════════════════
  // WIRING: Block Found → Security L2 + AuxPoW + Template
  // ═══════════════════════════════════════════════════════

  shareProcessor.on('blockFound', async (template, client) => {
    log.info({
      height: template.height,
      worker: client.workerName,
      reward: template.coinbasevalue / 1e8,
    }, '🎉 LTC BLOCK FOUND');

    stratumServer.stats.blocksFound++;
    workerTracker.onBlockFound(client);

    // SecurityEngine L8: Reward miner reputation for block find
    securityEngine.onBlockFound(client.minerAddress).catch(err =>
      log.error({ err: err.message }, 'SecurityEngine onBlockFound error')
    );

    // v0.7.0: IP reputation boost + audit + WebSocket broadcast
    ipReputation.recordBlockFound(client.remoteAddress);
    auditLog.security('block_found', {
      height: template.height,
      worker: client.workerName,
      address: client.minerAddress,
      ip: client.remoteAddress,
      severity: 'INFO',
    });

    await templateManager.updateTemplate();
  });

  // ═══════════════════════════════════════════════════════
  // WIRING: Disconnect → Cleanup
  // ═══════════════════════════════════════════════════════

  function handleDisconnect(client) {
    hashrateEstimator.removeWorker(client.id);
    fleetManager.removeMiner(client.id);
    workerTracker.onDisconnect(client);

    // SecurityEngine: L3 cookie revoke, L5 session analysis, L6/L7 cleanup
    securityEngine.onDisconnect({
      id: client.id,
      ip: client.remoteAddress,
      address: client.minerAddress,
    }).catch(err => log.error({ err: err.message }, 'SecurityEngine onDisconnect error'));

    // v0.7.0: Cleanup fingerprint, firmware, optimizer
    connectionFingerprint.onDisconnect(client.id);
    firmwareTracker.onDisconnect(client.id);
    hashrateOptimizer.removeMiner(client.id);
  }

  stratumServer.on('disconnect', handleDisconnect);
  soloServer.on('disconnect', handleDisconnect);

  // Wire L2 protocol validation into stratum server
  stratumServer.protocolValidator = (raw, ip) => securityEngine.checkProtocol(raw, ip);

  // ─── Start Network Servers ──────────────────────────────
  stratumServer.start();
  stratumSSL.start();
  soloServer.start();

  // ─── Block Watcher ──────────────────────────────────────
  const blockWatcher = new BlockConfirmationWatcher(
    { db: dbQuery, rpcClients: allRpcClients },
    60000
  );
  blockWatcher.start();

  blockWatcher.on('blockConfirmed', (block, coin) => {
    log.info({ coin, height: block.height }, '✅ Block confirmed');
  });
  blockWatcher.on('blockOrphaned', (block, coin) => {
    log.warn({ coin, height: block.height }, '⚠️  Block orphaned');
  });

  // ─── Payment Processors ─────────────────────────────────
  if (config.payment.enabled) {
    const ltcPayments = new PaymentProcessor(
      ltcRpc, dbQuery, redis,
      {
        interval: config.payment.interval,
        minPayout: config.payment.minPayout,
        maxBatch: config.payment.maxBatch,
        scheme: config.payment.scheme,
        pplnsWindow: config.payment.pplnsWindow,
        poolFee: config.pool.fee,
        fleetAddresses: fleetManager.whitelistedAddresses,
      },
      redisKeys
    );
    ltcPayments.start();

    if (Object.keys(auxRpcClients).length > 0) {
      const multiPay = new MultiCoinPaymentProcessor(
        { rpcClients: auxRpcClients, db: dbQuery, redis },
        {
          interval: config.payment.interval,
          poolFee: config.pool.fee,
          pplnsWindow: config.payment.pplnsWindow,
        }
      );
      multiPay.start();
    }
  }

  // ─── API Server (with security routes) ──────────────────
  const apiApp = createApiServer({
    db: dbQuery, redis, redisKeys, stratumServer, soloServer,
    rpcClient: ltcRpc, auxRpcClients, auxPowEngine,
    hashrateEstimator, banningManager, blockWatcher,
    securityEngine, fleetManager,
    workerTracker, healthMonitor,
    // v0.7.0: New dependencies for dashboard + admin routes
    hashrateOptimizer, ipReputation, emergencyLockdown,
    auditLog, minerRegistry, firmwareTracker,
    connectionFingerprint,
  });

  const httpServer = apiApp.listen(config.api.port, config.api.host, () => {
    log.info({ port: config.api.port }, '🌐 API server listening');
  });

  // v0.7.0: WebSocket server — attach to HTTP server
  const wsServer = new PoolWebSocketServer({
    stratumServer, hashrateEstimator, emergencyLockdown, workerTracker,
    adminToken: config.api.adminToken,
  });
  wsServer.attach(httpServer);

  // SecurityEngine L9: Wire alert hook → operator dashboard WebSocket
  securityEngine.onAlert(event => {
    wsServer.broadcastSecurityEvent({ type: 'security_alert', ...event });
  });

  // Wire WebSocket broadcasts to events
  shareProcessor.on('blockFound', (template, client) => {
    wsServer.broadcastBlock({
      height: template.height,
      worker: client.workerName,
      coin: 'LTC',
      reward: template.coinbasevalue / 1e8,
    });
  });

  emergencyLockdown.on('levelChanged', (data) => {
    wsServer.broadcastLockdown(data);
  });

  connectionFingerprint.on('clusterDetected', (cluster) => {
    wsServer.broadcastSecurityEvent({ type: 'cluster', ...cluster });
  });

  hashrateOptimizer.on('underperformance', (data) => {
    wsServer.broadcastSecurityEvent({ type: 'underperformance', ...data });
  });

  // ─── Stats Collector ────────────────────────────────────
  const statsCollector = new StatsCollector({
    db: dbQuery, redis, stratumServer, rpcClient: ltcRpc,
  });
  statsCollector.start();

  // ─── Graceful Shutdown ──────────────────────────────────
  const shutdown = async (signal) => {
    log.info({ signal }, 'Shutting down LUXXPOOL...');
    // v0.7.0: Stop new modules first
    wsServer.stop();
    hashrateOptimizer.stop();
    firmwareTracker.stop();
    emergencyLockdown.stop();
    connectionFingerprint.stop();
    ipReputation.stop();
    await auditLog.stop();
    // Core modules
    statsCollector.stop();
    hashrateEstimator.stop();
    workerTracker.stop();
    healthMonitor.stop();
    blockWatcher.stop();
    banningManager.stop();
    securityEngine.stop();
    blockNotifier.stop();
    templateManager.stop();
    auxPowEngine.stop();
    stratumServer.stop();
    stratumSSL.stop();
    soloServer.stop();
    try { await redis.quit(); } catch {}
    try { const { closeDatabase } = require('./utils/database'); await closeDatabase(); } catch {}
    log.info('LUXXPOOL shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    log.error({ err: err?.message || err }, 'Unhandled rejection');
  });

  const auxList = Object.keys(auxRpcClients).join(', ') || 'none';
  log.info(`
  ═══════════════════════════════════════════════════════
  LUXXPOOL v${version} IS RUNNING — ALL SYSTEMS WIRED
  ─────────────────────────────────────────────────────
  Pool Stratum:   :${config.stratum.port}
  SSL Stratum:    :${config.stratum.portSsl}
  Solo Stratum:   :${config.stratum.portSolo}
  API:            :${config.api.port}
  ─────────────────────────────────────────────────────
  Parent: LTC  │  Aux: ${auxList}
  Pool Fee: ${config.pool.fee * 100}%  │  Solo: ${(parseFloat(process.env.SOLO_FEE || '0.01')) * 100}%
  Fleet Fee: ${fleetManager.fleetFee * 100}%  │  Scheme: ${config.payment.scheme.toUpperCase()}
  ─────────────────────────────────────────────────────
  Fleet:          🏗  ${(process.env.FLEET_IPS || '').split(',').filter(Boolean).length} IPs whitelisted
  Security:       🛡️  9-Layer SecurityEngine + IP Reputation + Lockdown
  WebSocket:      🔌 /ws (pool, blocks, miner, admin)
  Miner Models:   🔧 ${minerRegistry.getAllModels().length} ASIC profiles loaded
  Redis:          ${redisConnected ? '✅' : '⚠️  degraded'}
  ═══════════════════════════════════════════════════════
  `);
}

main().catch((err) => {
  log.fatal({ err: err.message, stack: err.stack }, 'Fatal startup error');
  process.exit(1);
});
