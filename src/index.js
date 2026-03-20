/**
 * ═══════════════════════════════════════════════════════════════
 *  LUXXPOOL v0.4.0 — Scrypt Multi-Coin Merged Mining Pool
 *  Main Process — Full System Orchestrator
 *
 *  ALL SYSTEMS WIRED:
 *    Stratum (pool/SSL/solo) → BanningManager → SecurityManager
 *    → ShareProcessor → HashrateEstimator → BlockTemplateManager
 *    → AuxPowEngine → BlockWatcher → PaymentProcessors → API
 *
 *  v0.4.0 Fixes:
 *    - SecurityManager WIRED (was dead code in v0.3.x)
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
const { SecurityManager }   = require('./pool/securityManager');
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
  if (ltcAlive) {
    const info = await ltcRpc.getBlockchainInfo();
    log.info({ chain: info.chain, blocks: info.blocks }, 'Litecoin daemon connected');
  } else {
    log.fatal('Cannot connect to Litecoin daemon — aborting');
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
  // SECURITY ENGINE — v0.4.0 WIRED
  // ═══════════════════════════════════════════════════════
  const securityManager = new SecurityManager(
    {
      fingerprint: {
        windowBlocks: 100,
        bwhThreshold: 0.95,
        minShareSample: 500,
      },
      anomaly: {
        maxSharesPerSecond: 10,
        maxNtimeDeviation: 300,
        hashrateVarianceThreshold: 5.0,
      },
    },
    { db: dbQuery, banningManager }
  );
  securityManager.start();

  log.info('🛡️  Security engine ACTIVE — all 3 layers wired');

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
  securityManager.ipReputation = ipReputation;
  securityManager.auditLog = auditLog;
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

  // ═══════════════════════════════════════════════════════
  // FLEET MANAGEMENT — v0.5.1
  // Distinguishes LUXX-owned miners from public miners
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

    const cookie = securityManager.generateCookie(client.id, client.extraNonce1);
    client._miningCookie = cookie;
    client._isFleet = isFleet;

    log.debug({ ip: client.remoteAddress, agent, fleet: isFleet, model: model?.name || 'unknown' }, 'Miner subscribed');
  });

  // Register miners on authorize (now we know their address)
  stratumServer.on('authorize', (client, workerName) => {
    const type = fleetManager.classify(client.remoteAddress, client.minerAddress);
    client._isFleet = type === 'fleet';
    fleetManager.registerMiner(client);
    workerTracker.onConnect(client, client.userAgent || 'unknown');

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
    const cookie = securityManager.generateCookie(client.id, client.extraNonce1);
    client._miningCookie = cookie;
    client._isFleet = isFleet;
    fleetManager.registerMiner(client);
  });

  // ═══════════════════════════════════════════════════════
  // WIRING: Share Submission → Full Pipeline
  // Fleet: skip ban + anomaly checks (trusted hardware)
  // Public: ban → anomaly(L3) → share processor
  // ═══════════════════════════════════════════════════════

  function handleShare(client, share) {
    if (!client._isFleet) {
      // PUBLIC MINERS: full security pipeline
      if (banningManager.isBanned(client.remoteAddress)) {
        client.rejectShare(share.id, STRATUM.errors.BANNED.code, STRATUM.errors.BANNED.message);
        client.disconnect('banned');
        return;
      }

      const anomalies = securityManager.anomalyEngine.analyzeShare(client, share);
      if (anomalies) {
        for (const alert of anomalies) {
          if (alert.severity === 'HIGH') {
            banningManager.ban(client.remoteAddress, `Security: ${alert.type}`);
            client.rejectShare(share.id, STRATUM.errors.SECURITY.code, STRATUM.errors.SECURITY.message);
            client.disconnect('security ban');
            return;
          }
        }
      }
    }
    // Layer 1: Mining cookie validation (anti-hijack) — applies to all miners
    const cookie = securityManager.cookieManager.getCookie(client.id);
    if (cookie && client._miningCookie !== cookie) {
      client.rejectShare(share.id, STRATUM.errors.SECURITY.code, 'Cookie mismatch');
      client.disconnect('cookie mismatch');
      return;
    }

    // FLEET + PUBLIC: share validation is always the same (honest work = honest work)
    shareProcessor.processShare(client, share);
  }

  stratumServer.on('submit', handleShare);
  soloServer.on('submit', handleShare);

  // ═══════════════════════════════════════════════════════
  // WIRING: Share Results → Security + Hashrate
  // ═══════════════════════════════════════════════════════

  shareProcessor.on('validShare', (client, share) => {
    if (!client._isFleet) {
      banningManager.recordValidShare(client.remoteAddress);
      securityManager.fingerprintEngine.recordShare(client.minerAddress, share.difficulty, false);
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
  });

  shareProcessor.on('invalidShare', (client, share, reason) => {
    workerTracker.onInvalidShare(client);
    if (!client._isFleet) {
      banningManager.recordInvalidShare(client.remoteAddress);
      securityManager.anomalyEngine.analyzeShare(client, { ...share, _invalid: true });
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
    securityManager.fingerprintEngine.recordShare(client.minerAddress, 0, true);
    workerTracker.onBlockFound(client);

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
    securityManager.cookieManager.remove(client.id);
    fleetManager.removeMiner(client.id);
    workerTracker.onDisconnect(client);

    // v0.7.0: Cleanup fingerprint, firmware, optimizer
    connectionFingerprint.onDisconnect(client.id);
    firmwareTracker.onDisconnect(client.id);
    hashrateOptimizer.removeMiner(client.id);
  }

  stratumServer.on('disconnect', handleDisconnect);
  soloServer.on('disconnect', handleDisconnect);

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
    securityManager, fleetManager,
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
    securityManager.stop();
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
  Security:       🛡️  3-Layer + IP Reputation + Lockdown
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
