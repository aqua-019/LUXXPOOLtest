/**
 * LUXXPOOL — SSL/TLS Stratum Server
 * Wraps the core stratum server with TLS encryption on port 3334
 */

const tls = require('tls');
const fs = require('fs');
const { createLogger } = require('../utils/logger');

const log = createLogger('stratum:ssl');

class StratumSSL {
  /**
   * @param {import('./server').StratumServer} stratumServer - Base stratum server (shares event bus)
   * @param {object} config
   * @param {string} config.host
   * @param {number} config.port - SSL port (default 3334)
   * @param {string} config.certPath - Path to SSL certificate
   * @param {string} config.keyPath - Path to SSL private key
   */
  constructor(stratumServer, config) {
    this.stratumServer = stratumServer;
    this.config = config;
    this.server = null;
  }

  start() {
    const { certPath, keyPath, host, port } = this.config;

    if (!certPath || !keyPath) {
      log.warn('SSL cert/key not configured — SSL stratum disabled');
      return;
    }

    try {
      if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
        log.warn({ certPath, keyPath }, 'SSL cert/key files not found — SSL stratum disabled');
        return;
      }

      const tlsOptions = {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
        // Allow self-signed certs for mining (miners don't verify)
        rejectUnauthorized: false,
      };

      this.server = tls.createServer(tlsOptions, (socket) => {
        // Delegate to the existing stratum server's connection handler
        // The socket behaves identically to a plain TCP socket
        log.info({ ip: socket.remoteAddress }, 'SSL miner connection');
        this.stratumServer._handleConnection(socket);
      });

      this.server.maxConnections = 10000;

      this.server.listen(port, host, () => {
        log.info({ host, port }, '🔒 SSL Stratum server listening');
      });

      this.server.on('error', (err) => {
        log.error({ err: err.message }, 'SSL Stratum server error');
      });

      this.server.on('tlsClientError', (err, tlsSocket) => {
        log.warn({ ip: tlsSocket.remoteAddress, err: err.message }, 'TLS handshake failed');
      });

    } catch (err) {
      log.error({ err: err.message }, 'Failed to start SSL Stratum server');
    }
  }

  stop() {
    if (this.server) {
      this.server.close();
      log.info('SSL Stratum server stopped');
    }
  }
}

module.exports = StratumSSL;
