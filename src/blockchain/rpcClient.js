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

  /**
   * Submit a solved block (retries on transient failure).
   *
   * Each attempt inherits the call()-level 30s socket timeout, but we also
   * impose an absolute per-attempt 30s deadline here using AbortController.
   * If the daemon hangs without sending data on an open socket, the inner
   * timeout would still fire — but the AbortController ceiling is the
   * stronger guarantee and emits a distinct BLOCK_RPC_TIMEOUT event so
   * "block submission stuck" is visible in the dashboard.
   */
  async submitBlock(blockHex) {
    const maxRetries = 3;
    const SUBMIT_TIMEOUT_MS = 30_000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), SUBMIT_TIMEOUT_MS);
      try {
        const racer = new Promise((_, reject) => {
          ac.signal.addEventListener('abort', () => {
            this.log.error({ attempt, ms: SUBMIT_TIMEOUT_MS }, 'BLOCK_RPC_TIMEOUT submitblock exceeded ceiling');
            try {
              poolLogger.emit('DAEMON_002', { chain: this._chainLabel(), rpc: 'submitblock', attempt });
            } catch (_) { /* logger best-effort */ }
            reject(new Error(`submitblock timed out after ${SUBMIT_TIMEOUT_MS}ms (attempt ${attempt})`));
          }, { once: true });
        });
        const result = await Promise.race([this.call('submitblock', [blockHex]), racer]);
        return result;
      } catch (err) {
        if (attempt === maxRetries) throw err;
        const delay = 100 * Math.pow(2, attempt - 1); // 100ms, 200ms, 400ms
        this.log.warn({ attempt, err: err.message }, `submitblock failed, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } finally {
        clearTimeout(timer);
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

  /** Get wallet-known transaction (includes details, confirmations, etc.) */
  async getTransaction(txid) {
    return this.call('gettransaction', [txid, true]);
  }

  /** List recent wallet transactions (used for payment reconciliation) */
  async listRecentTransactions(count = 200) {
    return this.call('listtransactions', ['*', count, 0, true]);
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
