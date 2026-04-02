/**
 * LUXXPOOL — Share Processor
 * Validates submitted shares, detects block solutions,
 * and records valid shares to the database.
 */

const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');
const { STRATUM } = require('../ux/copy');
const {
  sha256d,
  scryptHashAsync,
  difficultyToTarget,
  bitsToTarget,
  bitsToDifficulty,
  meetsTarget,
  calculateMerkleRoot,
  reverseBuffer,
  reverseHex,
} = require('../utils/hashing');

const log = createLogger('shares');

class ShareProcessor extends EventEmitter {
  /**
   * @param {import('../blockchain/blockTemplate')} templateManager
   * @param {import('../blockchain/rpcClient')} rpcClient
   * @param {object} poolConfig
   * @param {object} db - Database interface
   * @param {object} redis - Redis client
   */
  constructor(templateManager, rpcClient, poolConfig, db, redis, redisKeys) {
    super();
    this.templateManager = templateManager;
    this.rpc = rpcClient;
    this.poolConfig = poolConfig;
    this.db = db;
    this.redis = redis;
    this.keys = redisKeys;

    // Redis-backed duplicate share detection
    const RedisShareDedup = require('./redisDedup');
    this.dedup = new RedisShareDedup(redis, redisKeys);
  }

  /**
   * Process a submitted share from a miner
   * @param {import('../stratum/server').StratumClient} client
   * @param {object} share - Share data from mining.submit
   */
  async processShare(client, share) {
    const { jobId, extraNonce1, extraNonce2, ntime, nonce } = share;

    try {
      // ── Step 0: Validate share field formats ──
      if (!/^[0-9a-fA-F]{8}$/.test(nonce)) {
        client.rejectShare(share.id, STRATUM.errors.LOW_DIFFICULTY.code, 'Invalid nonce format');
        this._recordShare(client, share, null, 'rejected', 'bad nonce').catch(() => {});
        this.emit('invalidShare', client, share, 'bad nonce');
        return;
      }
      if (!/^[0-9a-fA-F]{8}$/.test(extraNonce2)) {
        client.rejectShare(share.id, STRATUM.errors.LOW_DIFFICULTY.code, 'Invalid extraNonce2 format');
        this._recordShare(client, share, null, 'rejected', 'bad extraNonce2').catch(() => {});
        this.emit('invalidShare', client, share, 'bad extraNonce2');
        return;
      }

      // ── Step 1: Validate job exists ──
      const jobEntry = this.templateManager.getJob(jobId);
      if (!jobEntry) {
        client.rejectShare(share.id, STRATUM.errors.JOB_NOT_FOUND.code, STRATUM.errors.JOB_NOT_FOUND.message);
        client.shares.stale++;
        this._recordShare(client, share, null, 'stale', 'job not found').catch(() => {});
        this.emit('staleShare', client, share);
        return;
      }

      const template = jobEntry.template;

      // ── Step 2: Duplicate detection (Redis-backed v0.4.0) ──
      const isDup = await this.dedup.isDuplicate(extraNonce1, extraNonce2, ntime, nonce, jobId);
      if (isDup) {
        client.rejectShare(share.id, STRATUM.errors.DUPLICATE_SHARE.code, STRATUM.errors.DUPLICATE_SHARE.message);
        this.emit('duplicateShare', client, share);
        return;
      }

      // ── Step 3: Validate ntime ──
      const ntimeInt = parseInt(ntime, 16);
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(ntimeInt - now) > 600) {
        client.rejectShare(share.id, STRATUM.errors.INVALID_NTIME.code, STRATUM.errors.INVALID_NTIME.message);
        this.emit('invalidShare', client, share, 'bad ntime');
        return;
      }

      // ── Step 4: Build block header ──
      const headerBuffer = this._buildBlockHeader(
        template, jobId, extraNonce1, extraNonce2, ntime, nonce
      );

      // ── Step 5: Hash and validate (async — non-blocking) ──
      const hash = await scryptHashAsync(headerBuffer);

      // Check against share difficulty (miner's target)
      const shareTarget = difficultyToTarget(share.difficulty);
      if (!meetsTarget(hash, shareTarget)) {
        client.rejectShare(share.id, STRATUM.errors.LOW_DIFFICULTY.code, STRATUM.errors.LOW_DIFFICULTY.message);
        this._recordShare(client, share, template, 'rejected', 'low difficulty').catch(() => {});
        this.emit('invalidShare', client, share, 'low difficulty');
        return;
      }

      // ── Step 6: Share is valid ──
      client.acceptShare(share.id);

      // Update VarDiff
      const vardiffRatio = client.vardiff.recordShare();
      if (vardiffRatio !== null) {
        const newDiff = client.vardiff.applyAdjustment(client.difficulty, vardiffRatio);
        if (newDiff !== client.difficulty) {
          log.info({
            worker: client.workerName,
            oldDiff: client.difficulty,
            newDiff,
          }, 'VarDiff adjustment');
          client.sendDifficulty(newDiff);
        }
      }

      // ── Step 7: Record share ──
      await this._recordShare(client, share, template);

      // ── Step 8: Check for block solution (LTC parent chain) ──
      const networkTarget = bitsToTarget(template.bits);
      if (meetsTarget(hash, networkTarget)) {
        log.info({
          height: template.height,
          hash: reverseBuffer(hash).toString('hex'),
          worker: client.workerName,
          difficulty: share.difficulty,
        }, '🎉 BLOCK FOUND!');

        await this._submitBlock(template, headerBuffer, extraNonce1, extraNonce2, ntime, nonce, client, jobId);
      }

      // ── Step 9: Emit valid share with aux-proof data for merged mining ──
      // Aux chains have lower difficulty — every valid share could solve an aux block.
      const job = this.templateManager.getJob(jobId);
      const { coinbaseHex } = this.templateManager.buildCoinbaseForJob(jobId, extraNonce1, extraNonce2);
      this.emit('validShare', client, share, {
        hash,
        headerBuffer,
        coinbaseHex,
        merkleBranches: job ? job.merkleBranches : [],
      });

    } catch (err) {
      log.error({ err: err.message, worker: client.workerName }, 'Share processing error');
      client.rejectShare(share.id, STRATUM.errors.INTERNAL.code, STRATUM.errors.INTERNAL.message);
    }
  }

  // ═══════════════════════════════════════════════════════
  // BLOCK HEADER CONSTRUCTION
  // ═══════════════════════════════════════════════════════

  /**
   * Build an 80-byte block header for hashing.
   *
   * CRITICAL v0.4.1 FIX: Uses the STORED job's precomputed
   * coinbase parts and merkle branches — NOT the current template.
   * Also reverses previousblockhash to match what the miner received.
   */
  _buildBlockHeader(template, jobId, extraNonce1, extraNonce2, ntime, nonce) {
    // Get stored job data (precomputed when job was created)
    const job = this.templateManager.getJob(jobId);
    if (!job) throw new Error('Job not found for header construction');

    // Build coinbase from the STORED coinbase parts (not current template)
    const { coinbaseHash } = this.templateManager.buildCoinbaseForJob(jobId, extraNonce1, extraNonce2);

    // Calculate merkle root using STORED merkle branches
    let merkleRoot;
    if (job.merkleBranches.length === 0) {
      merkleRoot = coinbaseHash;
    } else {
      merkleRoot = calculateMerkleRoot(coinbaseHash, job.merkleBranches);
    }

    // Assemble header (80 bytes)
    const header = Buffer.alloc(80);
    let offset = 0;

    // Version (4 bytes LE)
    header.writeInt32LE(template.version, offset);
    offset += 4;

    // Previous block hash (32 bytes) — MUST be in internal byte order
    // getblocktemplate returns big-endian (display). Miner received it reversed.
    // We must reverse it here to match what the miner hashed.
    const prevHashBuf = Buffer.from(job.prevHashReversed, 'hex');
    prevHashBuf.copy(header, offset);
    offset += 32;

    // Merkle root (32 bytes)
    merkleRoot.copy(header, offset);
    offset += 32;

    // nTime (4 bytes LE)
    header.writeUInt32LE(parseInt(ntime, 16), offset);
    offset += 4;

    // nBits (4 bytes LE)
    header.writeUInt32LE(parseInt(template.bits, 16), offset);
    offset += 4;

    // Nonce (4 bytes LE)
    header.writeUInt32LE(parseInt(nonce, 16), offset);

    return header;
  }

  // ═══════════════════════════════════════════════════════
  // BLOCK SUBMISSION
  // ═══════════════════════════════════════════════════════

  async _submitBlock(template, header, extraNonce1, extraNonce2, ntime, nonce, client, jobId) {
    try {
      // Build full block (header + transactions)
      const { coinbaseHex } = this.templateManager.buildCoinbaseForJob(jobId, extraNonce1, extraNonce2);

      // Serialize block
      const parts = [];
      parts.push(header);

      // Transaction count
      const txCount = template.transactions.length + 1; // +1 for coinbase
      if (txCount < 0xfd) {
        parts.push(Buffer.from([txCount]));
      } else {
        const buf = Buffer.alloc(3);
        buf[0] = 0xfd;
        buf.writeUInt16LE(txCount, 1);
        parts.push(buf);
      }

      // Coinbase transaction
      parts.push(Buffer.from(coinbaseHex, 'hex'));

      // Other transactions
      for (const tx of template.transactions) {
        parts.push(Buffer.from(tx.data, 'hex'));
      }

      const blockHex = Buffer.concat(parts).toString('hex');

      // Submit to daemon
      const result = await this.rpc.submitBlock(blockHex);

      if (result === null || result === undefined) {
        log.info({
          height: template.height,
          worker: client.workerName,
          reward: template.coinbasevalue / 1e8,
        }, '✅ Block accepted by network!');

        await this._recordBlock(template, client, header);
        this.emit('blockFound', template, client);
      } else {
        log.error({ result, height: template.height }, '❌ Block rejected by network');
        this.emit('blockRejected', template, client, result);
      }

    } catch (err) {
      log.error({ err: err.message, height: template.height }, 'Block submission failed');
    }
  }

  // ═══════════════════════════════════════════════════════
  // DATABASE RECORDING
  // ═══════════════════════════════════════════════════════

  async _recordShare(client, share, template, status = 'valid', reason = null) {
    const shareData = {
      worker: client.workerName,
      address: client.minerAddress,
      difficulty: share.difficulty,
      height: template ? template.height : 0,
      ip: client.remoteAddress,
      timestamp: Date.now(),
    };

    // Redis: increment share counter for PPLNS window (valid shares only)
    if (status === 'valid' && template) {
      try {
        const pipeline = this.redis.pipeline();
        pipeline.hincrby(this.keys.roundShares(template.height), client.minerAddress, share.difficulty);
        pipeline.incr(this.keys.totalShares());
        pipeline.hincrby(this.keys.workerShares(client.minerAddress), 'total', share.difficulty);
        pipeline.set(this.keys.workerLastShare(client.minerAddress), Date.now());
        await pipeline.exec();
      } catch (err) {
        log.error({ err: err.message }, 'Redis share recording failed');
      }
    }

    // PostgreSQL: persistent share record (all statuses)
    if (this.db) {
      try {
        await this.db.query(
          `INSERT INTO shares (worker, address, difficulty, height, ip, status, rejection_reason, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
          [shareData.worker, shareData.address, shareData.difficulty, shareData.height, shareData.ip, status, reason]
        );
      } catch (err) {
        log.error({ err: err.message }, 'PostgreSQL share recording failed');
      }
    }
  }

  async _recordBlock(template, client, header) {
    if (!this.db) return;

    // Compute the actual block hash from the 80-byte header
    const blockHash = reverseBuffer(sha256d(header)).toString('hex');

    try {
      await this.db.query(
        `INSERT INTO blocks (height, hash, reward, worker, address, difficulty, is_solo, solo_fee, confirmed, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, NOW())`,
        [
          template.height,
          blockHash,
          template.coinbasevalue,
          client.workerName,
          client.minerAddress,
          bitsToDifficulty(template.bits).toFixed(8),
          client.isSolo || false,
          client.soloFee || 0,
        ]
      );
    } catch (err) {
      log.error({ err: err.message, height: template.height }, 'Block recording failed');
    }
  }

}

module.exports = ShareProcessor;
