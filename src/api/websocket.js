/**
 * LUXXPOOL v0.7.0 — WebSocket Server
 * ═══════════════════════════════════════════════════════════
 * Real-time data push for dashboard applications.
 *
 * Channels:
 *   pool          — Pool stats broadcast every 10s
 *   blocks        — New block notifications (on discovery)
 *   miner:<addr>  — Per-miner updates every 30s
 *   admin         — Auth required, security events + lockdown
 *
 * Attaches to the existing Express HTTP server.
 * Uses the `ws` package (already a dependency).
 */

const WebSocket = require('ws');
const { createLogger } = require('../utils/logger');

const log = createLogger('websocket');

class PoolWebSocketServer {
  /**
   * @param {object} deps - Dependencies from index.js
   * @param {object} opts
   */
  constructor(deps = {}, opts = {}) {
    this.deps = deps;
    this.adminToken = deps.adminToken || null;
    this.maxConnections = opts.maxConnections || 500;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs || 30000;
    this.poolBroadcastIntervalMs = opts.poolBroadcastIntervalMs || 10000;
    this.minerBroadcastIntervalMs = opts.minerBroadcastIntervalMs || 30000;

    this.wss = null;
    this.clients = new Map(); // ws → { subscriptions: Set, authenticated: boolean }
    this.heartbeatTimer = null;
    this.poolBroadcastTimer = null;
    this.minerBroadcastTimer = null;
  }

  /**
   * Attach WebSocket server to an HTTP server instance.
   */
  attach(httpServer) {
    this.wss = new WebSocket.Server({
      server: httpServer,
      path: '/ws',
      maxPayload: 4096, // 4KB max message size
    });

    this.wss.on('connection', (ws, req) => {
      this._handleConnection(ws, req);
    });

    // Start broadcast timers
    this.heartbeatTimer = setInterval(() => this._heartbeat(), this.heartbeatIntervalMs);
    this.poolBroadcastTimer = setInterval(() => this._broadcastPool(), this.poolBroadcastIntervalMs);
    this.minerBroadcastTimer = setInterval(() => this._broadcastMiners(), this.minerBroadcastIntervalMs);

    log.info({ path: '/ws', maxConnections: this.maxConnections }, 'WebSocket server attached');
  }

  stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.poolBroadcastTimer) clearInterval(this.poolBroadcastTimer);
    if (this.minerBroadcastTimer) clearInterval(this.minerBroadcastTimer);
    if (this.wss) this.wss.close();
  }

  /**
   * Broadcast a new block notification to all subscribed clients.
   */
  broadcastBlock(blockData) {
    this._broadcast('blocks', {
      type: 'block',
      data: blockData,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast a security event to admin channel.
   */
  broadcastSecurityEvent(event) {
    this._broadcastAdmin({
      type: 'security',
      data: event,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast lockdown level change.
   */
  broadcastLockdown(status) {
    this._broadcastAdmin({
      type: 'lockdown',
      data: status,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast firmware alert.
   */
  broadcastFirmwareAlert(alert) {
    this._broadcastAdmin({
      type: 'firmware',
      data: alert,
      timestamp: Date.now(),
    });
  }

  // ─── Internal ──────────────────────────────────────────

  _handleConnection(ws, req) {
    // Connection limit
    if (this.clients.size >= this.maxConnections) {
      ws.close(1013, 'Max connections reached');
      return;
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.socket.remoteAddress;

    this.clients.set(ws, {
      subscriptions: new Set(['pool']), // default subscription
      authenticated: false,
      ip,
      connectedAt: Date.now(),
    });

    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
      this._handleMessage(ws, data);
    });

    ws.on('close', () => {
      this.clients.delete(ws);
    });

    ws.on('error', () => {
      this.clients.delete(ws);
    });

    // Send welcome message
    this._send(ws, {
      type: 'connected',
      channels: ['pool', 'blocks', 'miner:<address>', 'admin'],
      timestamp: Date.now(),
    });

    log.debug({ ip, clients: this.clients.size }, 'WebSocket client connected');
  }

  _handleMessage(ws, data) {
    const client = this.clients.get(ws);
    if (!client) return;

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignore malformed
    }

    switch (msg.action) {
      case 'subscribe': {
        const channel = msg.channel;
        if (!channel) return;

        // Admin channel requires auth
        if (channel === 'admin') {
          if (!this.adminToken || msg.token !== this.adminToken) {
            this._send(ws, { type: 'error', message: 'Admin authentication required' });
            return;
          }
          client.authenticated = true;
        }

        client.subscriptions.add(channel);
        this._send(ws, { type: 'subscribed', channel });
        break;
      }

      case 'unsubscribe': {
        client.subscriptions.delete(msg.channel);
        this._send(ws, { type: 'unsubscribed', channel: msg.channel });
        break;
      }

      default:
        break;
    }
  }

  _broadcastPool() {
    const { stratumServer, hashrateEstimator, emergencyLockdown } = this.deps;

    const data = {
      type: 'pool_stats',
      data: {
        hashrate: stratumServer ? stratumServer.getPoolHashrate() : 0,
        miners: stratumServer ? stratumServer.clients.size : 0,
        blocksFound: stratumServer ? stratumServer.stats.blocksFound : 0,
        lockdownLevel: emergencyLockdown ? emergencyLockdown.getLevel() : 0,
        poolHashrate: hashrateEstimator ? hashrateEstimator.getPoolHashrate() : 0,
      },
      timestamp: Date.now(),
    };

    this._broadcast('pool', data);
  }

  _broadcastMiners() {
    const { workerTracker } = this.deps;
    if (!workerTracker) return;

    // Broadcast per-miner updates to subscribed channels
    const workers = workerTracker.getAllWorkers();
    for (const worker of workers) {
      const channel = `miner:${worker.minerAddress}`;
      this._broadcast(channel, {
        type: 'miner_update',
        data: worker,
        timestamp: Date.now(),
      });
    }
  }

  _broadcast(channel, message) {
    const payload = JSON.stringify(message);
    for (const [ws, client] of this.clients) {
      if (client.subscriptions.has(channel) && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
        } catch {
          // ignore send errors
        }
      }
    }
  }

  _broadcastAdmin(message) {
    const payload = JSON.stringify(message);
    for (const [ws, client] of this.clients) {
      if (client.authenticated && client.subscriptions.has('admin') && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
        } catch {
          // ignore
        }
      }
    }
  }

  _send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // ignore
      }
    }
  }

  _heartbeat() {
    if (!this.wss) return;

    for (const [ws] of this.clients) {
      if (!ws.isAlive) {
        this.clients.delete(ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }
}

module.exports = PoolWebSocketServer;
