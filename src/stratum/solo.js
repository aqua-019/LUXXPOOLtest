/**
 * LUXXPOOL — Solo Mining Server
 * Port 3336: Miners keep 100% of block rewards.
 * Pool charges a flat solo fee. No share-based payouts.
 *
 * Solo miners connect identically to pool miners but their
 * block rewards go directly to their own address.
 */

const net = require('net');
const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');
const { StratumClient } = require('./server');

const log = createLogger('solo');

class SoloMiningServer extends EventEmitter {
  /**
   * @param {object} config
   * @param {string} config.host
   * @param {number} config.port - Solo port (default 3336)
   * @param {number} config.difficulty - Starting difficulty
   * @param {number} config.soloFee - Solo mining fee as decimal (default 0.01 = 1%)
   * @param {object} config.vardiff
   * @param {import('../blockchain/blockTemplate')} templateManager
   */
  constructor(config, templateManager) {
    super();
    this.config = config;
    this.templateManager = templateManager;
    this.clients = new Map();
    this.ipCounts = new Map();
    this.server = null;

    this.stats = {
      totalConnections: 0,
      blocksFound: 0,
    };
  }

  start() {
    this.server = net.createServer((socket) => {
      this._handleConnection(socket);
    });

    this.server.listen(this.config.port, this.config.host, () => {
      log.info({
        host: this.config.host,
        port: this.config.port,
        fee: (this.config.soloFee || 0.01) * 100 + '%',
      }, '⛏  Solo mining server listening');
    });

    this.server.on('error', (err) => {
      log.fatal({ err: err.message }, 'Solo server error');
    });

    // Broadcast new jobs to solo miners
    this.templateManager.on('newJob', (job) => {
      this._broadcastJob(job);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      for (const [, client] of this.clients) {
        client.disconnect('server shutdown');
      }
    }
    log.info('Solo mining server stopped');
  }

  _handleConnection(socket) {
    const ip = socket.remoteAddress;

    // Per-IP limit
    const ipCount = (this.ipCounts.get(ip) || 0) + 1;
    if (ipCount > 3) { // Tighter limit for solo
      socket.destroy();
      return;
    }
    this.ipCounts.set(ip, ipCount);

    const extraNonce1 = this.templateManager.allocateExtraNonce1();

    const client = new StratumClient(socket, extraNonce1, {
      difficulty: this.config.difficulty || 512,
      vardiff: this.config.vardiff,
    });

    // Tag as solo miner
    client.isSolo = true;
    client.soloFee = this.config.soloFee || 0.01;

    this.clients.set(client.id, client);
    this.stats.totalConnections++;

    log.info({
      ip,
      clientId: client.id,
      mode: 'SOLO',
    }, 'New solo miner connection');

    client.on('authorize', (c, workerName) => {
      log.info({
        worker: workerName,
        ip,
        mode: 'SOLO',
      }, 'Solo miner authorized');

      // Send current job
      const job = this.templateManager._buildStratumJob();
      if (job) client.sendJob(job);

      this.emit('authorize', c, workerName);
    });

    client.on('submit', (c, share) => {
      // Emit for the share processor, tagged as solo
      share.isSolo = true;
      share.soloFee = client.soloFee;
      share.minerAddress = client.minerAddress;
      this.emit('submit', c, share);
    });

    client.on('disconnect', (c) => {
      this.clients.delete(c.id);
      const currentIpCount = (this.ipCounts.get(ip) || 1) - 1;
      if (currentIpCount <= 0) this.ipCounts.delete(ip);
      else this.ipCounts.set(ip, currentIpCount);

      log.info({ worker: c.workerName, ip, mode: 'SOLO' }, 'Solo miner disconnected');
      this.emit('disconnect', c);
    });
  }

  _broadcastJob(job) {
    for (const [, client] of this.clients) {
      if (client.authorized) {
        client.sendJob(job);
      }
    }
  }

  getClients() {
    return Array.from(this.clients.values());
  }
}

module.exports = SoloMiningServer;
