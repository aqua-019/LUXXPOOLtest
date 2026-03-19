/**
 * LUXXPOOL — Block Notifier
 * Detects new blocks via ZMQ (primary) with RPC polling fallback.
 * Emits 'newBlock' when a new block is detected on the network.
 */

const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');

const log = createLogger('blocknotifier');

class BlockNotifier extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}  opts.host           - ZMQ host
   * @param {number}  opts.port           - ZMQ port
   * @param {boolean} opts.enabled        - Whether ZMQ is enabled
   * @param {number}  opts.pollIntervalMs - Polling interval in ms
   * @param {import('./rpcClient')} opts.rpcClient - RPC client for polling fallback
   */
  constructor(opts) {
    super();
    this.zmqHost = opts.host || '127.0.0.1';
    this.zmqPort = opts.port || 28332;
    this.zmqEnabled = opts.enabled || false;
    this.pollIntervalMs = opts.pollIntervalMs || 1000;
    this.rpc = opts.rpcClient;

    this._zmqActive = false;
    this._zmqSocket = null;
    this._pollTimer = null;
    this._lastBlockHeight = null;
    this._stopped = false;
  }

  /**
   * Start block detection — tries ZMQ first, always starts polling fallback
   */
  async start() {
    if (this.zmqEnabled) {
      await this._startZmq();
    }

    this._startPolling();

    log.info({
      zmq: this._zmqActive,
      pollMs: this.pollIntervalMs,
    }, `Block notifier started (ZMQ: ${this._zmqActive ? 'active' : 'disabled'}, polling: ${this.pollIntervalMs}ms)`);
  }

  /**
   * Whether ZMQ is active and connected
   */
  isZMQ() {
    return this._zmqActive;
  }

  /**
   * Stop all block detection
   */
  stop() {
    this._stopped = true;

    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }

    if (this._zmqSocket) {
      try {
        this._zmqSocket.close();
      } catch (err) {
        log.warn({ err: err.message }, 'Error closing ZMQ socket');
      }
      this._zmqSocket = null;
      this._zmqActive = false;
    }

    log.info('Block notifier stopped');
  }

  /**
   * Attempt to start ZMQ subscriber
   */
  async _startZmq() {
    try {
      const zmq = require('zeromq');
      const sock = new zmq.Subscriber();
      const endpoint = `tcp://${this.zmqHost}:${this.zmqPort}`;

      await sock.connect(endpoint);
      sock.subscribe('hashblock');

      this._zmqSocket = sock;
      this._zmqActive = true;

      log.info({ endpoint }, 'ZMQ subscriber connected');

      // Start async message reader
      this._readZmqMessages(sock);
    } catch (err) {
      log.warn({ err: err.message }, 'ZMQ not available — using polling only');
      this._zmqActive = false;
    }
  }

  /**
   * Async loop reading ZMQ messages
   */
  async _readZmqMessages(sock) {
    try {
      for await (const [topic, msg] of sock) {
        if (this._stopped) break;

        const topicStr = topic.toString();
        if (topicStr === 'hashblock') {
          const blockHash = msg.toString('hex');
          log.debug({ blockHash }, 'ZMQ hashblock received');
          this.emit('newBlock', blockHash);
        }
      }
    } catch (err) {
      if (!this._stopped) {
        log.error({ err: err.message }, 'ZMQ connection lost — polling will continue');
        this._zmqActive = false;
      }
    }
  }

  /**
   * Start RPC polling for new blocks
   */
  _startPolling() {
    this._pollTimer = setInterval(async () => {
      try {
        const height = await this.rpc.getBlockCount();

        if (this._lastBlockHeight === null) {
          this._lastBlockHeight = height;
          return;
        }

        if (height > this._lastBlockHeight) {
          log.debug({ height, prev: this._lastBlockHeight }, 'Poll detected new block');
          this._lastBlockHeight = height;

          // Only emit from polling if ZMQ is not active (avoid duplicate events)
          if (!this._zmqActive) {
            this.emit('newBlock', null);
          }
        }
      } catch (err) {
        log.warn({ err: err.message }, 'Block polling RPC failed');
      }
    }, this.pollIntervalMs);
  }
}

module.exports = BlockNotifier;
