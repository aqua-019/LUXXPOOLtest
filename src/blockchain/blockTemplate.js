/**
 * LUXXPOOL — Block Template Manager
 * Manages block templates from the Litecoin daemon, constructs coinbase
 * transactions, and generates work for stratum clients.
 */

const crypto = require('crypto');
const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');
const {
  sha256d,
  reverseBuffer,
  reverseHex,
  intToLE32,
  serializeVarInt,
  buildMerkleBranches,
} = require('../utils/hashing');

const log = createLogger('blocktemplate');

class BlockTemplateManager extends EventEmitter {
  /**
   * @param {import('./rpcClient')} rpcClient - Litecoin RPC client
   * @param {object} poolConfig - Pool configuration
   */
  constructor(rpcClient, poolConfig) {
    super();
    this.rpc = rpcClient;
    this.poolConfig = poolConfig;

    this.currentTemplate = null;
    this.currentJobId = null;
    this.extraNonce1Size = 4;  // bytes
    this.extraNonce2Size = 4;  // bytes
    this.extraNonceCounter = 0;

    this.validJobs = new Map(); // jobId → template
    this.maxJobs = 10;

    this.pollInterval = null;
    this.lastBestBlockHash = null;
  }

  // ═══════════════════════════════════════════════════════
  // TEMPLATE UPDATES — ZMQ + POLLING FALLBACK
  // ═══════════════════════════════════════════════════════

  /**
   * Start block template updates.
   * Uses ZMQ for instant notifications if available, with
   * polling as a fallback at a slower rate (15s instead of 1s).
   * @param {number} pollIntervalMs - Fallback polling interval
   */
  start(pollIntervalMs = 1000) {
    // Try ZMQ first
    const zmqEndpoint = process.env.LTC_ZMQ_HASHBLOCK || '';
    if (zmqEndpoint) {
      this._startZmq(zmqEndpoint, pollIntervalMs);
    } else {
      log.info({ interval: pollIntervalMs }, 'ZMQ not configured — using polling only');
      this._startPolling(pollIntervalMs);
    }
  }

  /**
   * Start ZMQ subscriber for instant block notifications.
   * Falls back to slow polling if ZMQ disconnects.
   */
  _startZmq(endpoint, fallbackPollMs) {
    try {
      const zmq = require('zeromq');
      this.zmqSock = new zmq.Subscriber();
      this.zmqSock.connect(endpoint);
      this.zmqSock.subscribe('hashblock');

      this.zmqActive = true;
      log.info({ endpoint }, 'ZMQ hashblock subscriber connected');

      // Process ZMQ messages
      (async () => {
        for await (const [topic, msg] of this.zmqSock) {
          if (topic.toString() === 'hashblock') {
            const hash = msg.toString('hex');
            log.info({ hash: hash.substring(0, 16) + '...' }, 'ZMQ: new block notification');
            await this.updateTemplate();
          }
        }
      })().catch(err => {
        log.warn({ err: err.message }, 'ZMQ subscriber disconnected — falling back to polling');
        this.zmqActive = false;
        this._startPolling(fallbackPollMs);
      });

      // Still poll as safety net, but at 15s instead of 1s
      this._startPolling(15000);

    } catch (err) {
      // zeromq not installed — fall back to polling
      log.warn({ err: err.message }, 'ZMQ unavailable — using polling');
      this._startPolling(fallbackPollMs);
    }
  }

  _startPolling(intervalMs) {
    if (this.pollInterval) clearInterval(this.pollInterval);
    log.info({ interval: intervalMs, zmq: !!this.zmqActive }, 'Polling started');
    this._poll();
    this.pollInterval = setInterval(() => this._poll(), intervalMs);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.zmqSock) {
      try { this.zmqSock.close(); } catch {}
      this.zmqSock = null;
    }
    log.info('Block template updates stopped');
  }

  async _poll() {
    try {
      const bestHash = await this.rpc.getBestBlockHash();

      // Only fetch new template if block changed or no template exists
      if (bestHash !== this.lastBestBlockHash || !this.currentTemplate) {
        this.lastBestBlockHash = bestHash;
        await this.updateTemplate();
      }
    } catch (err) {
      log.error({ err: err.message }, 'Block template poll failed');
    }
  }

  /**
   * Force a new block template fetch and broadcast
   */
  async updateTemplate() {
    try {
      const template = await this.rpc.getBlockTemplate();

      this.currentTemplate = template;
      this.currentJobId = this._generateJobId();

      // Precompute coinbase parts and merkle branches for this job
      // These MUST be stored so share validation uses the SAME data
      // the miner received — not whatever the current template is.
      const [coinbase1, coinbase2] = this._getCoinbaseParts();

      const txHashes = template.transactions.map(tx =>
        Buffer.from(tx.hash || tx.txid, 'hex')
      );
      const merkleBranches = buildMerkleBranches(txHashes);

      // Store COMPLETE job data for share validation
      this.validJobs.set(this.currentJobId, {
        template,
        coinbase1,                                        // Buffer
        coinbase2,                                        // Buffer
        merkleBranches,                                   // Buffer[]
        prevHashReversed: reverseHex(template.previousblockhash), // hex string (internal byte order)
        createdAt: Date.now(),
      });

      // Evict old jobs
      if (this.validJobs.size > this.maxJobs) {
        const oldest = this.validJobs.keys().next().value;
        this.validJobs.delete(oldest);
      }

      log.info({
        height: template.height,
        txCount: template.transactions.length,
        jobId: this.currentJobId,
      }, 'New block template');

      // Emit the new job for stratum broadcast
      this.emit('newJob', this._buildStratumJob());

      return this.currentJobId;
    } catch (err) {
      log.error({ err: err.message }, 'Failed to get block template');
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════
  // COINBASE CONSTRUCTION
  // ═══════════════════════════════════════════════════════

  /**
   * Build a coinbase transaction for the current template
   * Split into two parts around the extraNonce insertion point
   * @param {string} extraNonce1Hex - 4 bytes hex
   * @param {string} extraNonce2Hex - 4 bytes hex
   * @returns {{ coinbaseHex: string, coinbaseHash: Buffer }}
   */
  buildCoinbase(extraNonce1Hex, extraNonce2Hex) {
    const template = this.currentTemplate;
    if (!template) throw new Error('No template available');

    const [part1, part2] = this._getCoinbaseParts();

    const extraNonce = Buffer.from(extraNonce1Hex + extraNonce2Hex, 'hex');
    const coinbase = Buffer.concat([part1, extraNonce, part2]);
    const coinbaseHash = sha256d(coinbase);

    return {
      coinbaseHex: coinbase.toString('hex'),
      coinbaseHash,
    };
  }

  /**
   * Build coinbase from a STORED job's precomputed parts.
   * This is the CORRECT method for share validation — uses the
   * exact coinbase parts the miner received, not the current template.
   * @param {string} jobId
   * @param {string} extraNonce1Hex
   * @param {string} extraNonce2Hex
   * @returns {{ coinbaseHex: string, coinbaseHash: Buffer }}
   */
  buildCoinbaseForJob(jobId, extraNonce1Hex, extraNonce2Hex) {
    const job = this.validJobs.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    const extraNonce = Buffer.from(extraNonce1Hex + extraNonce2Hex, 'hex');
    const coinbase = Buffer.concat([job.coinbase1, extraNonce, job.coinbase2]);
    const coinbaseHash = sha256d(coinbase);

    return {
      coinbaseHex: coinbase.toString('hex'),
      coinbaseHash,
    };
  }

  /**
   * Get coinbase split into two parts for stratum protocol
   * Returns [coinbase1, coinbase2] hex strings
   */
  _getCoinbaseParts() {
    const template = this.currentTemplate;
    const blockReward = template.coinbasevalue;
    const poolFee = this.poolConfig.fee;
    const feeAddress = this.poolConfig.feeAddress;

    // ── Build coinbase transaction ──
    const parts = [];

    // Version (4 bytes LE)
    const version = Buffer.alloc(4);
    version.writeInt32LE(1);
    parts.push(version);

    // Input count (1 input - coinbase)
    parts.push(Buffer.from([0x01]));

    // Previous tx hash (32 zero bytes for coinbase)
    parts.push(Buffer.alloc(32));

    // Previous output index (0xFFFFFFFF)
    parts.push(Buffer.from('ffffffff', 'hex'));

    // Coinbase script (scriptSig)
    // Block height serialization (BIP34)
    const heightBuf = this._serializeBlockHeight(template.height);
    
    // Pool tag
    const poolTag = Buffer.from(`/LUXXPOOL/${Date.now()}/`, 'ascii');
    
    // scriptSig = height + poolTag + [EXTRANONCE GOES HERE]
    const scriptSigPre = Buffer.concat([heightBuf, poolTag]);
    const scriptSigLen = scriptSigPre.length + this.extraNonce1Size + this.extraNonce2Size;

    parts.push(serializeVarInt(scriptSigLen));
    parts.push(scriptSigPre);

    // ← THIS IS WHERE WE SPLIT FOR EXTRANONCE ←
    const coinbasePart1 = Buffer.concat(parts);

    // After extranonce: sequence + outputs
    const parts2 = [];

    // Input sequence (0xFFFFFFFF)
    parts2.push(Buffer.from('ffffffff', 'hex'));

    // Calculate outputs
    const feeAmount = Math.floor(blockReward * poolFee);
    const minerReward = blockReward - feeAmount;

    let outputCount = 1;
    if (feeAmount > 0 && feeAddress) outputCount++;
    // Add default_witness_commitment if present
    if (template.default_witness_commitment) outputCount++;

    parts2.push(serializeVarInt(outputCount));

    // Output 1: Miner reward (to pool address, distributed later)
    const rewardBuf = Buffer.alloc(8);
    rewardBuf.writeBigInt64LE(BigInt(minerReward));
    parts2.push(rewardBuf);

    // Output script (pay-to-pool-address) - placeholder
    // In production, this is derived from the coinbaseaux or pool wallet
    const outputScript = template.coinbasetxn && template.coinbasetxn.data
      ? Buffer.from(template.coinbasetxn.data, 'hex')
      : this._buildOutputScript(feeAddress || 'POOL_ADDRESS_PLACEHOLDER');
    parts2.push(serializeVarInt(outputScript.length));
    parts2.push(outputScript);

    // Output 2: Pool fee (if applicable)
    if (feeAmount > 0 && feeAddress) {
      const feeBuf = Buffer.alloc(8);
      feeBuf.writeBigInt64LE(BigInt(feeAmount));
      parts2.push(feeBuf);

      const feeScript = this._buildOutputScript(feeAddress);
      parts2.push(serializeVarInt(feeScript.length));
      parts2.push(feeScript);
    }

    // Segwit commitment output
    if (template.default_witness_commitment) {
      const witnessBuf = Buffer.alloc(8);
      witnessBuf.writeBigInt64LE(0n);
      parts2.push(witnessBuf);

      const witnessScript = Buffer.from(template.default_witness_commitment, 'hex');
      parts2.push(serializeVarInt(witnessScript.length));
      parts2.push(witnessScript);
    }

    // Lock time (4 bytes)
    parts2.push(Buffer.alloc(4));

    const coinbasePart2 = Buffer.concat(parts2);

    return [coinbasePart1, coinbasePart2];
  }

  /**
   * Serialize block height for BIP34 coinbase
   */
  _serializeBlockHeight(height) {
    if (height < 17) {
      return Buffer.from([0x01, height + 0x50]);
    }

    const heightHex = height.toString(16);
    const paddedHex = heightHex.length % 2 ? '0' + heightHex : heightHex;
    const heightBytes = Buffer.from(paddedHex, 'hex').reverse();
    return Buffer.concat([Buffer.from([heightBytes.length]), heightBytes]);
  }

  /**
   * Build output script from a Litecoin address
   * Supports P2PKH (L...), P2SH (M...), and Bech32 (ltc1...)
   */
  _buildOutputScript(address) {
    const { addressToOutputScript } = require('../utils/addressCodec');
    try {
      return addressToOutputScript(address);
    } catch (err) {
      log.error({ address, err: err.message }, 'Failed to decode address — using fallback P2PKH');
      // Fallback: P2PKH with SHA256-derived hash (ONLY for development)
      const hash = crypto.createHash('sha256').update(address).digest().slice(0, 20);
      return Buffer.concat([
        Buffer.from([0x76, 0xa9, 0x14]),
        hash,
        Buffer.from([0x88, 0xac]),
      ]);
    }
  }

  // ═══════════════════════════════════════════════════════
  // STRATUM JOB CONSTRUCTION
  // ═══════════════════════════════════════════════════════

  /**
   * Build stratum mining.notify parameters
   */
  _buildStratumJob() {
    const template = this.currentTemplate;
    const [coinbase1, coinbase2] = this._getCoinbaseParts();

    // Transaction hashes for merkle branches
    const txHashes = template.transactions.map(tx =>
      Buffer.from(tx.hash || tx.txid, 'hex')
    );
    const merkleBranches = buildMerkleBranches(txHashes);

    return {
      jobId:          this.currentJobId,
      prevHash:       reverseHex(template.previousblockhash),
      coinbase1:      coinbase1.toString('hex'),
      coinbase2:      coinbase2.toString('hex'),
      merkleBranches: merkleBranches.map(b => b.toString('hex')),
      version:        intToLE32(template.version).toString('hex'),
      nbits:          template.bits,
      ntime:          Math.floor(Date.now() / 1000).toString(16),
      cleanJobs:      true,

      // Metadata for share validation
      _height:         template.height,
      _target:         template.target,
      _reward:         template.coinbasevalue,
    };
  }

  /**
   * Get a job by its ID (for share validation)
   */
  getJob(jobId) {
    return this.validJobs.get(jobId);
  }

  /**
   * Generate a unique extraNonce1 for a new miner connection
   * @returns {string} hex string
   */
  allocateExtraNonce1() {
    this.extraNonceCounter++;
    const buf = Buffer.alloc(this.extraNonce1Size);
    buf.writeUInt32BE(this.extraNonceCounter);
    return buf.toString('hex');
  }

  _generateJobId() {
    return crypto.randomBytes(4).toString('hex');
  }
}

module.exports = BlockTemplateManager;
