/**
 * LUXXPOOL — ZMQ Block Notifier (Stub)
 * ZMQ functionality is handled internally by BlockNotifier.
 * This module exists for import compatibility only.
 */

const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');

const log = createLogger('zmqnotifier');

class ZmqBlockNotifier extends EventEmitter {
  constructor(endpoint) {
    super();
    this.endpoint = endpoint;
  }

  async start() {
    log.info('ZmqBlockNotifier is deprecated — ZMQ is handled by BlockNotifier');
  }

  stop() {
    // no-op
  }
}

module.exports = ZmqBlockNotifier;
