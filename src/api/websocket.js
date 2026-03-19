/**
 * LUXXPOOL v0.7.0 — WebSocket Server
 * Real-time data push for dashboard applications.
 *
 * Channels:
 *   "pool"            — Public pool stats (hashrate, miners, shares)
 *   "blocks"          — New block notifications
 *   "miner:<address>" — Per-miner hashrate and worker updates
 *   "admin"           — Security events, audit feed (requires auth)
 *
 * Protocol:
 *   Client → Server:  { type: "subscribe", channel: "pool" }
 *   Client → Server:  { type: "auth", token: "..." }  (for admin channel)
 *   Server → Client:  { channel: "pool", event: "stats", data: {...} }
 */

const WebSocket = require('ws');
const { createLogger } = require('../utils/logger');
const config = require('../../config');

const log = createLogger('websocket');

class PoolWebSocket {
  /**
   * @param {object} httpServer - HTTP server to attach to
   * @param {object} deps - { stratumServer, hashrateEstimator, securityManager, adminToken }
   */
  constructor(httpServer, deps) {
    this.deps = deps;
    this.wss = null;
    this.clients = new Map(); // ws → { channels: Set, authenticated: boolean, ip: string }
    this.statsTimer = null;
    this.hashrateTimer = null;

    if (!httpServer) return;

    this.wss = new WebSocket.Server({
      server: httpServer,
      path: '/ws',
      maxPayload: 4096,        // 4KB max message from clients
    });

    this.wss.on('connection', (ws, req) => this._handleConnection(ws, req));
  }

  start() {
    if (!this.wss) return;

    // Broadcast pool stats every 5 seconds
    this.statsTimer = setInterval(() => this._broadcastPoolStats(), 5000);

    // Broadcast hashrate updates every 30 seconds
    this.hashrateTimer = setInterval(() => this._broadcastHashrateUpdate(), 30000);

    // Ping/pong keepalive
    const pingInterval = config.websocket?.pingInterval || 30000;
    this.pingTimer = setInterval(() => {
      for (const [ws] of this.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, pingInterval);

    log.info('WebSocket server started');
  }

  stop() {
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.hashrateTimer) clearInterval(this.hashrateTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.wss) this.wss.close();
  }

  /**
   * Broadcast a new block event to all subscribers.
   * @param {object} block - Block data
   */
  broadcastNewBlock(block) {
    this._broadcast('blocks', 'new_block', {
      coin: block.coin,
      height: block.height,
      hash: block.hash,
      reward: block.reward,
      worker: block.worker,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Broadcast a security event to admin subscribers.
   * @param {object} event - Security event data
   */
  broadcastSecurityEvent(event) {
    this._broadcast('admin', 'security_event', event);
  }

  /**
   * Broadcast a lockdown level change.
   * @param {object} data - { previous, current, reason }
   */
  broadcastLockdownChange(data) {
    this._broadcast('admin', 'lockdown_change', data);
    // Also notify pool channel (non-sensitive summary)
    this._broadcast('pool', 'pool_status', {
      lockdownLevel: data.current,
      message: data.current > 0 ? 'Pool operating in restricted mode' : 'Pool operating normally',
    });
  }

  /**
   * Get WebSocket server stats.
   * @returns {{ connections, channels }}
   */
  getStats() {
    const channels = {};
    for (const [, meta] of this.clients) {
      for (const ch of meta.channels) {
        channels[ch] = (channels[ch] || 0) + 1;
      }
    }

    return {
      connections: this.clients.size,
      channels,
    };
  }

  // ═══════════════════════════════════════════════════════
  // INTERNAL
  // ═══════════════════════════════════════════════════════

  _handleConnection(ws, req) {
    const maxConnections = config.websocket?.maxConnections || 100;
    if (this.clients.size >= maxConnections) {
      ws.close(1013, 'Max connections reached');
      return;
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const meta = { channels: new Set(), authenticated: false, ip };
    this.clients.set(ws, meta);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleMessage(ws, meta, msg);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
    });

    ws.on('error', () => {
      this.clients.delete(ws);
    });

    // Send welcome
    this._send(ws, { type: 'welcome', channels: ['pool', 'blocks', 'miner:<address>', 'admin (auth required)'] });
  }

  _handleMessage(ws, meta, msg) {
    switch (msg.type) {
      case 'subscribe': {
        const channel = msg.channel;
        if (!channel) return;

        // Admin channel requires authentication
        if (channel === 'admin' && !meta.authenticated) {
          this._send(ws, { type: 'error', message: 'Authentication required for admin channel' });
          return;
        }

        meta.channels.add(channel);
        this._send(ws, { type: 'subscribed', channel });
        break;
      }

      case 'unsubscribe': {
        const channel = msg.channel;
        if (channel) {
          meta.channels.delete(channel);
          this._send(ws, { type: 'unsubscribed', channel });
        }
        break;
      }

      case 'auth': {
        const adminToken = config.api.adminToken;
        if (adminToken && msg.token === adminToken) {
          meta.authenticated = true;
          this._send(ws, { type: 'authenticated' });
        } else {
          this._send(ws, { type: 'error', message: 'Invalid token' });
        }
        break;
      }

      default:
        break;
    }
  }

  _broadcastPoolStats() {
    const { stratumServer, hashrateEstimator } = this.deps;
    if (!stratumServer) return;

    const data = {
      hashrate: hashrateEstimator ? hashrateEstimator.getPoolHashrate() : 0,
      miners: stratumServer.clients ? stratumServer.clients.size : 0,
      timestamp: new Date().toISOString(),
    };

    this._broadcast('pool', 'stats', data);
  }

  _broadcastHashrateUpdate() {
    const { hashrateEstimator } = this.deps;
    if (!hashrateEstimator) return;

    // Broadcast per-miner updates to subscribers
    for (const [workerId, record] of hashrateEstimator.shareRecords) {
      if (!record.minerAddress) continue;
      const channel = `miner:${record.minerAddress}`;
      const hashrate = hashrateEstimator.getWorkerHashrate(workerId);

      this._broadcast(channel, 'hashrate', {
        workerId,
        address: record.minerAddress,
        hashrate,
        timestamp: new Date().toISOString(),
      });
    }
  }

  _broadcast(channel, event, data) {
    for (const [ws, meta] of this.clients) {
      if (meta.channels.has(channel) && ws.readyState === WebSocket.OPEN) {
        this._send(ws, { channel, event, data });
      }
    }
  }

  _send(ws, data) {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      // Client disconnected
    }
  }
}

module.exports = PoolWebSocket;
