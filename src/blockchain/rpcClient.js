/**
 * LUXXPOOL — Blockchain RPC Client
 * JSON-RPC 1.0 interface for Litecoin and Dogecoin daemons
 */

const http = require('http');
const { createLogger } = require('../utils/logger');
const poolLogger = require('../logging/poolLogger');

class RpcClient {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} opts.port
   * @param {string} opts.user
   * @param {string} opts.password
   * @param {string} [opts.coin='litecoin'] - Coin name for logging
   */
  constructor(opts) {
    this.host     = opts.host;
    this.port     = opts.port;
    this.auth     = Buffer.from(`${opts.user}:${opts.password}`).toString('base64');
    this.coin     = opts.coin || 'litecoin';
    this.timeout  = opts.timeout || 30000;
    this.log      = createLogger(`rpc:${this.coin}`);
    this.idCounter = 0;

    // Circuit breaker state
    this.consecutiveFailures = 0;
    this.circuitOpen = false;
    this.circuitOpenedAt = 0;
    this._circuitThreshold = opts.circuitThreshold || 5;
    this._circuitCooldownMs = opts.circuitCooldownMs || 30000;
  }

  /**
   * Execute a JSON-RPC method call
   * @param {string} method
   * @param {Array} params
   * @returns {Promise<any>}
   */
  async call(method, params = []) {
    // Circuit breaker: reject immediately if circuit is open and cooldown hasn't elapsed
    if (this.circuitOpen) {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed < this._circuitCooldownMs) {
        return Promise.reject(new Error(`RPC circuit open for ${this.coin} (${this.consecutiveFailures} failures, ${Math.round((this._circuitCooldownMs - elapsed) / 1000)}s remaining)`));
      }
      // Cooldown elapsed — allow one probe call through
      this.log.info({ method }, 'RPC circuit half-open — probing');
    }

    const id = ++this.idCounter;

    const payload = JSON.stringify({
      jsonrpc: '1.0',
      id,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: this.host,
        port:     this.port,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length':  Buffer.byteLength(payload),
          'Authorization':  `Basic ${this.auth}`,
        },
        timeout: this.timeout,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              const err = new Error(`RPC ${method}: ${parsed.error.message}`);
              err.code = parsed.error.code;
              this.log.error({ method, code: parsed.error.code }, `RPC error: ${parsed.error.message}`);
              if (method === 'getblocktemplate') {
                poolLogger.emit('DAEMON_008', { chain: this._chainLabel(), method, error: parsed.error.message });
              }
              reject(err);
            } else {
              this._onSuccess();
              resolve(parsed.result);
            }
          } catch (e) {
            this.log.error({ method, raw: data.substring(0, 200) }, 'Failed to parse RPC response');
            reject(new Error(`Failed to parse RPC response for ${method}`));
          }
        });
      });

      req.on('error', (err) => {
        this._onFailure();
        this.log.error({ method, err: err.message }, 'RPC connection error');
        poolLogger.emit('DAEMON_003', { chain: this._chainLabel(), error: err.message });
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        this._onFailure();
        this.log.error({ method }, 'RPC request timed out');
        poolLogger.emit('DAEMON_002', { chain: this._chainLabel(), rpc: method });
        reject(new Error(`RPC ${method} timed out`));
      });

      req.write(payload);
      req.end();
    });
  }

  // ═══════════════════════════════════════════════════════
  // CIRCUIT BREAKER
  // ═══════════════════════════════════════════════════════

  _chainLabel() {
    return (this.coin || 'LTC').toUpperCase();
  }

  _onSuccess() {
    if (this.circuitOpen) {
      this.log.info('RPC circuit closed — daemon recovered');
      poolLogger.emit('DAEMON_007', { chain: this._chainLabel() });
      poolLogger.emit('DAEMON_005', { chain: this._chainLabel() });
    }
    this.consecutiveFailures = 0;
    this.circuitOpen = false;
  }

  _onFailure() {
    this.consecutiveFailures++;
    if (!this.circuitOpen && this.consecutiveFailures >= this._circuitThreshold) {
      this.circuitOpen = true;
      this.circuitOpenedAt = Date.now();
      this.log.error({ failures: this.consecutiveFailures }, 'RPC circuit OPEN — daemon unreachable');
      poolLogger.emit('DAEMON_006', { chain: this._chainLabel(), failures: this.consecutiveFailures });
    }
  }

  // ═══════════════════════════════════════════════════════
  // MINING-SPECIFIC RPC METHODS
  // ═══════════════════════════════════════════════════════

  /** Get block template for mining */
  async getBlockTemplate(capabilities = ['coinbasetxn', 'workid', 'coinbase/append']) {
    return this.call('getblocktemplate', [{ capabilities }]);
  }

  /** Submit a solved block (retries on transient failure) */
  async submitBlock(blockHex) {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.call('submitblock', [blockHex]);
      } catch (err) {
        if (attempt === maxRetries) throw err;
        const delay = 100 * Math.pow(2, attempt - 1); // 100ms, 200ms, 400ms
        this.log.warn({ attempt, err: err.message }, `submitblock failed, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  /** Get blockchain info */
  async getBlockchainInfo() {
    return this.call('getblockchaininfo');
  }

  /** Get network info */
  async getNetworkInfo() {
    return this.call('getnetworkinfo');
  }

  /** Get mining info */
  async getMiningInfo() {
    return this.call('getmininginfo');
  }

  /** Get block count (height) */
  async getBlockCount() {
    return this.call('getblockcount');
  }

  /** Get best block hash */
  async getBestBlockHash() {
    return this.call('getbestblockhash');
  }

  /** Get block by hash */
  async getBlock(hash, verbosity = 1) {
    return this.call('getblock', [hash, verbosity]);
  }

  /** Get raw transaction */
  async getRawTransaction(txid, verbose = true) {
    return this.call('getrawtransaction', [txid, verbose]);
  }

  /** Validate address */
  async validateAddress(address) {
    return this.call('validateaddress', [address]);
  }

  /** Get wallet balance */
  async getBalance() {
    return this.call('getbalance');
  }

  /** Send coins to address */
  async sendToAddress(address, amount) {
    return this.call('sendtoaddress', [address, amount]);
  }

  /** Send many (batch payouts) */
  async sendMany(fromAccount, amounts) {
    return this.call('sendmany', [fromAccount, amounts]);
  }

  /** Create aux block (merged mining) */
  async createAuxBlock(address) {
    return this.call('createauxblock', [address]);
  }

  /** Submit aux block (merged mining) */
  async submitAuxBlock(hash, auxPow) {
    return this.call('submitauxblock', [hash, auxPow]);
  }

  /** Get connection count */
  async getConnectionCount() {
    return this.call('getconnectioncount');
  }

  /** Ping daemon to test connectivity */
  async ping() {
    try {
      await this.call('getblockcount');
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = RpcClient;
