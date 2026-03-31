/**
 * LUXXPOOL — Stratum Server
 * Handles TCP connections from mining hardware.
 * Implements Stratum v1 protocol for Scrypt (Litecoin) mining.
 */

const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');
const VarDiffManager = require('./vardiff');
const { STRATUM } = require('../ux/copy');

const log = createLogger('stratum');

// ═══════════════════════════════════════════════════════════
// STRATUM CLIENT
// ═══════════════════════════════════════════════════════════

class StratumClient extends EventEmitter {
  /**
   * @param {net.Socket} socket
   * @param {string} extraNonce1
   * @param {object} config
   */
  constructor(socket, extraNonce1, config) {
    super();

    this.id = crypto.randomUUID();
    this.socket = socket;
    this.extraNonce1 = extraNonce1;
    this.remoteAddress = socket.remoteAddress;
    this.connectedAt = Date.now();

    // Auth state
    this.authorized = false;
    this.workerName = null;   // full: "address.workerName"
    this.minerAddress = null; // just the litecoin address
    this.workerTag = null;    // just the worker identifier
    this.userAgent = null;    // v0.7.0: raw user-agent from subscribe

    // v0.7.0: Miner model detection
    this._minerModel = null;       // model profile from MinerRegistry
    this._firmwareVersion = null;  // extracted firmware version

    // Mining state
    this.difficulty = config.difficulty || 512;
    this.previousDifficulty = null;
    this.pendingDifficulty = null;

    // Statistics
    this.shares = { valid: 0, invalid: 0, stale: 0 };
    this.lastActivity = Date.now();
    this.hashrate = 0;

    // VarDiff
    this.vardiff = new VarDiffManager(config.vardiff);

    // v0.7.0: Per-client rate limiting (anti-DDoS, anti-share-flooding)
    // Addresses: documented 6.5M shares/sec VarDiff gaming exploit
    this._messageTimestamps = [];
    this._maxMessagesPerSec = 20;   // warn/disconnect threshold
    this._banMessagesPerSec = 50;   // instant ban threshold

    // L2 Protocol validation callback (set by SecurityEngine)
    this._protocolValidator = config.protocolValidator || null;

    // Socket handling
    this._buffer = '';
    this._setupSocket();
  }

  _setupSocket() {
    this.socket.setEncoding('utf8');
    this.socket.setKeepAlive(true, 30000);

    this.socket.on('data', (data) => {
      this.lastActivity = Date.now();

      // Check incoming data size before concatenating to prevent memory abuse
      if (data.length > 10240 || this._buffer.length + data.length > 10240) {
        log.warn({ ip: this.remoteAddress, dataLen: data.length, bufferLen: this._buffer.length }, 'Oversized message — disconnecting');
        this.disconnect('buffer overflow');
        return;
      }
      this._buffer += data;

      // Process line-delimited JSON
      const lines = this._buffer.split('\n');
      this._buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim().length === 0) continue;

        // L2 protocol validation (SecurityEngine integration)
        if (this._protocolValidator) {
          const check = this._protocolValidator(line, this.remoteAddress);
          if (check.result !== 'pass') {
            if (check.result === 'ban') {
              this.emit('protocolBan', this, check.reason);
              this.disconnect(check.reason);
              return;
            }
            // reject: skip this message
            this.shares.invalid++;
            continue;
          }
          // Use the pre-parsed message from L2
          this._handleMessage(check.parsed);
          continue;
        }

        // Fallback: original JSON parsing
        try {
          const message = JSON.parse(line);
          this._handleMessage(message);
        } catch (err) {
          log.warn({ ip: this.remoteAddress, raw: line.substring(0, 100) }, 'Malformed stratum message');
          this.shares.invalid++;
        }
      }

      // Buffer overflow protection
      if (this._buffer.length > 10240) {
        log.warn({ ip: this.remoteAddress }, 'Buffer overflow — disconnecting');
        this.disconnect('buffer overflow');
      }
    });

    this.socket.on('close', () => {
      this.emit('disconnect', this);
    });

    this.socket.on('error', (err) => {
      if (err.code !== 'ECONNRESET') {
        log.error({ ip: this.remoteAddress, err: err.message }, 'Socket error');
      }
      this.emit('disconnect', this);
    });

    this.socket.on('timeout', () => {
      log.info({ ip: this.remoteAddress, worker: this.workerName }, 'Connection timeout');
      this.disconnect('timeout');
    });

    this.socket.setTimeout(600000); // 10 minute idle timeout
  }

  // ═══════════════════════════════════════════════════════
  // MESSAGE HANDLING
  // ═══════════════════════════════════════════════════════

  _handleMessage(msg) {
    if (!msg.id && !msg.method) return;

    // v0.7.0: Per-client rate limiting
    const now = Date.now();
    this._messageTimestamps.push(now);
    const oneSecondAgo = now - 1000;
    this._messageTimestamps = this._messageTimestamps.filter(t => t > oneSecondAgo);
    if (this._messageTimestamps.length > this._banMessagesPerSec) {
      log.warn({ ip: this.remoteAddress, rate: this._messageTimestamps.length }, 'Message flood — banning');
      this.emit('rateLimit', this, 'ban');
      this.disconnect('message flood');
      return;
    }
    if (this._messageTimestamps.length > this._maxMessagesPerSec) {
      log.warn({ ip: this.remoteAddress, rate: this._messageTimestamps.length }, 'Rate limit exceeded');
      this.emit('rateLimit', this, 'warn');
      return; // drop message silently
    }

    switch (msg.method) {
      case 'mining.subscribe':
        this._handleSubscribe(msg);
        break;

      case 'mining.authorize':
        this._handleAuthorize(msg);
        break;

      case 'mining.submit':
        this._handleSubmit(msg);
        break;

      case 'mining.extranonce.subscribe':
        this._sendResponse(msg.id, true);
        break;

      case 'mining.get_transactions':
        this._sendResponse(msg.id, []);
        break;

      default:
        log.debug({ method: msg.method, ip: this.remoteAddress }, 'Unknown stratum method');
        this._sendError(msg.id, STRATUM.errors.UNKNOWN_METHOD.code, STRATUM.errors.UNKNOWN_METHOD.message);
    }
  }

  /**
   * mining.subscribe — Initial handshake
   */
  _handleSubscribe(msg) {
    const userAgent = msg.params ? msg.params[0] : 'unknown';
    this.userAgent = userAgent; // v0.7.0: store for model detection
    log.info({ ip: this.remoteAddress, agent: userAgent }, 'Miner subscribing');

    const subscriptions = [
      ['mining.set_difficulty', crypto.randomBytes(4).toString('hex')],
      ['mining.notify', crypto.randomBytes(4).toString('hex')],
    ];

    this._sendResponse(msg.id, [
      subscriptions,
      this.extraNonce1,
      4, // extraNonce2 size in bytes
    ]);

    // Send initial difficulty
    this.sendDifficulty(this.difficulty);

    this.emit('subscribe', this, userAgent);
  }

  /**
   * mining.authorize — Worker authentication
   */
  _handleAuthorize(msg) {
    const [workerName, password] = msg.params || [];

    if (!workerName) {
      this._sendResponse(msg.id, false);
      this._sendError(msg.id, STRATUM.errors.UNAUTHORIZED.code, STRATUM.errors.UNAUTHORIZED.message);
      return;
    }

    // Parse "address.workerName" format
    const parts = workerName.split('.');
    this.minerAddress = parts[0];
    this.workerTag = parts[1] || 'default';
    this.workerName = workerName;

    // Validate LTC address (v0.6.0: reject invalid, not just warn)
    try {
      const { validateAddress } = require('../utils/addressCodec');
      const validation = validateAddress(this.minerAddress);
      if (!validation.valid) {
        log.warn({ address: this.minerAddress, error: validation.error }, 'Rejected — invalid LTC address');
        this._sendResponse(msg.id, false);
        this._sendError(msg.id, STRATUM.errors.UNAUTHORIZED.code, 'Invalid Litecoin address — check worker format');
        return;
      }
    } catch (err) {
      // If codec itself crashes, allow through (don't brick the pool over a codec bug)
      log.error({ err: err.message, address: this.minerAddress }, 'Address validation error — allowing through');
    }

    this.authorized = true;

    log.info({
      ip: this.remoteAddress,
      worker: this.workerName,
      address: this.minerAddress,
    }, 'Worker authorized');

    this._sendResponse(msg.id, true);
    this.emit('authorize', this, workerName, password);
  }

  /**
   * mining.submit — Share submission
   */
  _handleSubmit(msg) {
    if (!this.authorized) {
      this._sendError(msg.id, STRATUM.errors.UNAUTHORIZED.code, STRATUM.errors.UNAUTHORIZED.message);
      return;
    }

    const [name, jobId, extraNonce2, ntime, nonce] = msg.params || [];

    if (!jobId || !extraNonce2 || !ntime || !nonce) {
      this.shares.invalid++;
      this._sendError(msg.id, STRATUM.errors.INVALID_PARAMS.code, STRATUM.errors.INVALID_PARAMS.message);
      return;
    }

    // Emit for share processor to validate
    this.emit('submit', this, {
      id: msg.id,
      workerName: name,
      jobId,
      extraNonce1: this.extraNonce1,
      extraNonce2,
      ntime,
      nonce,
      difficulty: this.difficulty,
    });
  }

  // ═══════════════════════════════════════════════════════
  // OUTBOUND MESSAGES
  // ═══════════════════════════════════════════════════════

  /**
   * Send mining.notify (new job)
   */
  sendJob(job) {
    this._sendNotification('mining.notify', [
      job.jobId,
      job.prevHash,
      job.coinbase1,
      job.coinbase2,
      job.merkleBranches,
      job.version,
      job.nbits,
      job.ntime,
      job.cleanJobs,
    ]);
  }

  /**
   * Send mining.set_difficulty
   */
  sendDifficulty(difficulty) {
    this.previousDifficulty = this.difficulty;
    this.difficulty = difficulty;
    this._sendNotification('mining.set_difficulty', [difficulty]);
  }

  /**
   * Accept a submitted share
   */
  acceptShare(msgId) {
    this.shares.valid++;
    this._sendResponse(msgId, true);
  }

  /**
   * Reject a submitted share
   */
  rejectShare(msgId, code, reason) {
    this.shares.invalid++;
    this._sendError(msgId, code, reason);
  }

  /**
   * Disconnect the client
   */
  disconnect(reason) {
    log.info({ ip: this.remoteAddress, worker: this.workerName, reason }, 'Disconnecting');
    try {
      this.socket.destroy();
    } catch (err) { log.debug({ err: err.message }, 'Socket destroy failed'); }
  }

  // ═══════════════════════════════════════════════════════
  // PROTOCOL HELPERS
  // ═══════════════════════════════════════════════════════

  _sendResponse(id, result) {
    this._send({ id, result, error: null });
  }

  _sendError(id, code, message) {
    this._send({ id, result: null, error: [code, message, null] });
  }

  _sendNotification(method, params) {
    this._send({ id: null, method, params });
  }

  _send(obj) {
    try {
      if (this.socket.writable) {
        this.socket.write(JSON.stringify(obj) + '\n');
      }
    } catch (err) {
      log.error({ err: err.message, ip: this.remoteAddress }, 'Failed to send');
    }
  }

  /**
   * Get client stats summary
   */
  toJSON() {
    return {
      id: this.id,
      worker: this.workerName,
      address: this.minerAddress,
      ip: this.remoteAddress,
      difficulty: this.difficulty,
      shares: this.shares,
      hashrate: this.hashrate,
      connectedAt: this.connectedAt,
      lastActivity: this.lastActivity,
      uptime: Date.now() - this.connectedAt,
    };
  }
}

// ═══════════════════════════════════════════════════════════
// STRATUM SERVER
// ═══════════════════════════════════════════════════════════

class StratumServer extends EventEmitter {
  /**
   * @param {object} config - Stratum configuration
   * @param {import('../blockchain/blockTemplate')} blockTemplateManager
   */
  constructor(config, blockTemplateManager) {
    super();

    this.config = config;
    this.templateManager = blockTemplateManager;
    this.clients = new Map();  // id → StratumClient
    this.ipCounts = new Map(); // ip → connection count

    this.server = null;
    this.protocolValidator = null; // Set by index.js to wire SecurityEngine L2
    this.stats = {
      totalConnections: 0,
      peakConnections: 0,
      totalSharesValid: 0,
      totalSharesInvalid: 0,
      blocksFound: 0,
    };
  }

  /**
   * Start listening for miner connections
   */
  start() {
    this.server = net.createServer((socket) => {
      this._handleConnection(socket);
    });

    this.server.maxConnections = 10000;

    this.server.listen(this.config.port, this.config.host, () => {
      log.info({
        host: this.config.host,
        port: this.config.port,
        difficulty: this.config.difficulty,
      }, '⛏  Stratum server listening');
    });

    this.server.on('error', (err) => {
      log.fatal({ err: err.message }, 'Stratum server error');
    });

    // Subscribe to new block templates
    this.templateManager.on('newJob', (job) => {
      this._broadcastJob(job);
    });

    // Periodic stats logging
    this._statsInterval = setInterval(() => this._logStats(), 60000);
  }

  stop() {
    if (this._statsInterval) clearInterval(this._statsInterval);
    if (this.server) {
      this.server.close();
      for (const [, client] of this.clients) {
        client.disconnect('server shutdown');
      }
    }
    log.info('Stratum server stopped');
  }

  /**
   * Handle a new incoming connection
   */
  _handleConnection(socket) {
    const ip = socket.remoteAddress;

    // Fleet whitelist check: fleet IPs bypass connection limits
    const isWhitelisted = this.config.isWhitelisted ? this.config.isWhitelisted(ip) : false;

    if (!isWhitelisted) {
      // DDoS: per-IP connection limit (public miners only)
      const ipCount = (this.ipCounts.get(ip) || 0) + 1;
      if (ipCount > (this.config.maxConnectionsPerIp || 5)) {
        log.warn({ ip, count: ipCount }, 'Too many connections from IP — rejected');
        socket.destroy();
        return;
      }
      this.ipCounts.set(ip, ipCount);
    }

    // Allocate unique extraNonce1
    const extraNonce1 = this.templateManager.allocateExtraNonce1();

    const client = new StratumClient(socket, extraNonce1, {
      difficulty: this.config.difficulty,
      vardiff: this.config.vardiff,
      protocolValidator: this.protocolValidator,
    });

    this.clients.set(client.id, client);
    this.stats.totalConnections++;
    this.stats.peakConnections = Math.max(this.stats.peakConnections, this.clients.size);

    log.info({
      ip,
      clientId: client.id,
      extraNonce1,
      activeClients: this.clients.size,
    }, 'New miner connection');

    // ── Event wiring ──

    client.on('subscribe', (c, agent) => {
      this.emit('subscribe', c, agent);
    });

    client.on('authorize', (c, workerName) => {
      this.emit('authorize', c, workerName);

      // Send the current job after authorization
      const job = this.templateManager._buildStratumJob();
      if (job) client.sendJob(job);
    });

    client.on('submit', (c, share) => {
      this.emit('submit', c, share);
    });

    client.on('disconnect', (c) => {
      this.clients.delete(c.id);

      const currentIpCount = (this.ipCounts.get(ip) || 1) - 1;
      if (currentIpCount <= 0) {
        this.ipCounts.delete(ip);
      } else {
        this.ipCounts.set(ip, currentIpCount);
      }

      log.info({
        worker: c.workerName,
        ip,
        shares: c.shares,
        uptime: Date.now() - c.connectedAt,
        activeClients: this.clients.size,
      }, 'Miner disconnected');

      this.emit('disconnect', c);
    });
  }

  /**
   * Broadcast a new job to all connected miners
   */
  _broadcastJob(job) {
    let count = 0;
    for (const [, client] of this.clients) {
      if (client.authorized) {
        client.sendJob(job);
        count++;
      }
    }
    log.info({ jobId: job.jobId, miners: count }, 'Job broadcast');
  }

  /**
   * Get a client by ID
   */
  getClient(id) {
    return this.clients.get(id);
  }

  /**
   * Get all connected clients
   */
  getClients() {
    return Array.from(this.clients.values());
  }

  /**
   * Get pool-wide hashrate estimate
   */
  getPoolHashrate() {
    let totalHashrate = 0;
    for (const [, client] of this.clients) {
      totalHashrate += client.hashrate || 0;
    }
    return totalHashrate;
  }

  _logStats() {
    log.info({
      activeMiners: this.clients.size,
      totalConnections: this.stats.totalConnections,
      peakConnections: this.stats.peakConnections,
      blocksFound: this.stats.blocksFound,
      poolHashrate: this.getPoolHashrate(),
    }, 'Pool stats');
  }
}

module.exports = { StratumServer, StratumClient };
