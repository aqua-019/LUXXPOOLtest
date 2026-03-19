/**
 * LUXXPOOL — Blockchain RPC Client
 * JSON-RPC 1.0 interface for Litecoin and Dogecoin daemons
 */

const http = require('http');
const { createLogger } = require('../utils/logger');

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
    this.log      = createLogger(`rpc:${this.coin}`);
    this.idCounter = 0;
  }

  /**
   * Execute a JSON-RPC method call
   * @param {string} method
   * @param {Array} params
   * @returns {Promise<any>}
   */
  async call(method, params = []) {
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
        timeout: 30000,
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
              reject(err);
            } else {
              resolve(parsed.result);
            }
          } catch (e) {
            this.log.error({ method, raw: data.substring(0, 200) }, 'Failed to parse RPC response');
            reject(new Error(`Failed to parse RPC response for ${method}`));
          }
        });
      });

      req.on('error', (err) => {
        this.log.error({ method, err: err.message }, 'RPC connection error');
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        this.log.error({ method }, 'RPC request timed out');
        reject(new Error(`RPC ${method} timed out`));
      });

      req.write(payload);
      req.end();
    });
  }

  // ═══════════════════════════════════════════════════════
  // MINING-SPECIFIC RPC METHODS
  // ═══════════════════════════════════════════════════════

  /** Get block template for mining */
  async getBlockTemplate(capabilities = ['coinbasetxn', 'workid', 'coinbase/append']) {
    return this.call('getblocktemplate', [{ capabilities }]);
  }

  /** Submit a solved block */
  async submitBlock(blockHex) {
    return this.call('submitblock', [blockHex]);
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
