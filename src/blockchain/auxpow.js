/**
 * LUXXPOOL — AuxPoW Merged Mining Engine
 * ═══════════════════════════════════════════════════════════
 * Manages simultaneous mining of LTC (parent) + N auxiliary
 * Scrypt chains. Each share is checked against every aux
 * chain's difficulty; if it meets any, that aux block is
 * submitted automatically.
 *
 * AuxPoW Protocol:
 *   1. createauxblock(address) → { hash, chainid, target }
 *   2. Embed aux merkle root in parent coinbase
 *   3. On valid share → submitauxblock(hash, auxpow_hex)
 */

const crypto = require('crypto');
const EventEmitter = require('events');
const { createLogger } = require('../utils/logger');
const poolLogger = require('../logging/poolLogger');
const { sha256d, reverseBuffer, reverseHex } = require('../utils/hashing');
const RpcClient = require('./rpcClient');
const { getAuxChains } = require('../../config/coins');

const log = createLogger('auxpow');

// Merged mining magic bytes (marks the aux merkle root in coinbase)
const MERGED_MINING_HEADER = Buffer.from('fabe6d6d', 'hex');

/**
 * Decode hex into a Buffer, asserting the resulting length when given.
 * Buffer.from(badHex, 'hex') silently truncates — a daemon-supplied hash
 * that happens to contain a non-hex character would produce a partial
 * buffer and a malformed AuxPoW proof. Throw early instead.
 */
function safeHexToBuffer(hex, label, expectedBytes) {
  if (typeof hex !== 'string') {
    throw new Error(`${label}: expected hex string, got ${typeof hex}`);
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`${label}: contains non-hex characters`);
  }
  if (hex.length % 2 !== 0) {
    throw new Error(`${label}: odd-length hex`);
  }
  const buf = Buffer.from(hex, 'hex');
  if (expectedBytes !== undefined && buf.length !== expectedBytes) {
    throw new Error(`${label}: expected ${expectedBytes} bytes, got ${buf.length}`);
  }
  return buf;
}

class AuxPowEngine extends EventEmitter {
  /**
   * @param {object} auxConfigs - Map of symbol → { host, port, user, password, address }
   */
  constructor(auxConfigs = {}, deps = {}) {
    super();

    this.chains = new Map();     // symbol → { rpc, config, currentBlock, ... }
    this.auxBlocks = new Map();  // symbol → { hash, target, chainid }
    this.pollInterval = null;
    this.redis = deps.redis || null;

    // Initialize RPC clients for each configured aux chain
    const enabledAux = getAuxChains();

    for (const [symbol, coinDef] of Object.entries(enabledAux)) {
      const conf = auxConfigs[symbol];
      if (!conf) {
        log.warn({ coin: symbol }, 'No RPC config for enabled aux chain — skipping');
        continue;
      }

      const rpc = new RpcClient({
        host: conf.host,
        port: conf.port || coinDef.defaultPort,
        user: conf.user,
        password: conf.password,
        coin: symbol.toLowerCase(),
      });

      this.chains.set(symbol, {
        rpc,
        config: coinDef,
        address: conf.address,     // Payout address for this coin
        currentBlock: null,
        lastHash: null,
        blocksFound: 0,
        enabled: true,
      });

      log.info({ coin: symbol, port: conf.port || coinDef.defaultPort }, 'Aux chain registered');
    }

    log.info({ chains: Array.from(this.chains.keys()) }, `AuxPoW engine initialized with ${this.chains.size} auxiliary chains`);
  }

  // ═══════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════

  /**
   * Start polling aux chains for new blocks
   */
  async start(intervalMs = 5000) {
    log.info('Starting AuxPoW engine');

    // Initial fetch for all chains
    await this.refreshAllAuxBlocks();

    // Poll for new aux blocks
    this.pollInterval = setInterval(() => this.refreshAllAuxBlocks(), intervalMs);
  }

  stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    log.info('AuxPoW engine stopped');
  }

  // ═══════════════════════════════════════════════════════
  // AUX BLOCK MANAGEMENT
  // ═══════════════════════════════════════════════════════

  /**
   * Fetch new aux blocks from all chains
   */
  async refreshAllAuxBlocks() {
    const promises = [];

    for (const [symbol, chain] of this.chains) {
      if (!chain.enabled) continue;
      promises.push(this._refreshAuxBlock(symbol, chain));
    }

    await Promise.allSettled(promises);
  }

  /**
   * Fetch a new aux block from a specific chain
   */
  async _refreshAuxBlock(symbol, chain) {
    try {
      // createauxblock returns { hash, chainid, target }
      const auxBlock = await chain.rpc.createAuxBlock(chain.address);

      if (!auxBlock || !auxBlock.hash) {
        log.warn({ coin: symbol }, 'Empty aux block response');
        return;
      }

      // Only update if block changed
      if (auxBlock.hash !== chain.lastHash) {
        chain.lastHash = auxBlock.hash;
        chain.currentBlock = auxBlock;

        this.auxBlocks.set(symbol, {
          hash: auxBlock.hash,
          target: auxBlock.target || auxBlock._target,
          chainId: auxBlock.chainid,
          bits: auxBlock.bits,
        });

        log.debug({
          coin: symbol,
          hash: auxBlock.hash.substring(0, 16) + '...',
          chainId: auxBlock.chainid,
        }, 'New aux block');

        this.emit('newAuxBlock', symbol, auxBlock);
      }
    } catch (err) {
      // Don't spam logs for offline chains
      if (!chain._lastError || Date.now() - chain._lastError > 60000) {
        log.warn({ coin: symbol, err: err.message }, 'Aux block fetch failed');
        chain._lastError = Date.now();
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // AUXILIARY MERKLE TREE
  // ═══════════════════════════════════════════════════════

  /**
   * Build the merged mining auxiliary merkle tree.
   * Returns data to embed in the parent (LTC) coinbase.
   *
   * @returns {{ auxMerkleRoot: Buffer, auxMerkleTree: Buffer[], auxMerkleSize: number, merkleNonce: number }}
   */
  buildAuxMerkleTree() {
    const auxBlocks = Array.from(this.auxBlocks.entries())
      .filter(([symbol]) => {
        const chain = this.chains.get(symbol);
        return chain && chain.enabled && chain.currentBlock;
      });

    if (auxBlocks.length === 0) {
      return null;
    }

    // Determine merkle tree size (smallest power of 2 >= chain count)
    let merkleSize = this._nextPowerOf2(Math.max(auxBlocks.length, 2));

    // Find a merkleNonce that produces no slot collisions for this chain set.
    // Linear probing produced slots that didn't match what _getAuxSlot returns,
    // so the daemon (which recomputes the expected slot from chainId + nonce)
    // would always reject. Rotating the nonce is the standard approach.
    const MAX_NONCE_TRIES = 65536;
    let merkleNonce = 0;
    let slots = null;
    while (slots === null) {
      for (; merkleNonce < MAX_NONCE_TRIES; merkleNonce++) {
        const candidate = new Array(merkleSize).fill(null);
        let collision = false;
        for (const [symbol, auxBlock] of auxBlocks) {
          const slot = this._getAuxSlot(auxBlock.chainId, merkleSize, merkleNonce);
          if (candidate[slot] !== null) { collision = true; break; }
          let hashBuf;
          try {
            hashBuf = safeHexToBuffer(auxBlock.hash, `auxBlock(${symbol}).hash`, 32);
          } catch (err) {
            log.error({ coin: symbol, err: err.message }, 'Aux block hash invalid — skipping chain');
            continue;
          }
          candidate[slot] = { symbol, hash: hashBuf };
        }
        if (!collision) { slots = candidate; break; }
      }
      if (slots === null) {
        // Exhausted nonce space at this size — double the tree and retry.
        const doubled = merkleSize * 2;
        log.warn({ chains: auxBlocks.length, merkleSize, doubled },
                 'Aux merkle: no collision-free nonce at current size — doubling tree');
        merkleSize = doubled;
        merkleNonce = 0;
      }
    }

    // Fill empty slots with zero hashes
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] === null) {
        slots[i] = { symbol: null, hash: Buffer.alloc(32) };
      }
    }

    // Build the merkle tree, retaining every level so we can derive
    // per-chain inclusion proofs (branches).
    const levels = [slots.map(s => s.hash)];
    while (levels[levels.length - 1].length > 1) {
      const cur = levels[levels.length - 1];
      const next = [];
      for (let i = 0; i < cur.length; i += 2) {
        const left = cur[i];
        const right = i + 1 < cur.length ? cur[i + 1] : left;
        next.push(sha256d(Buffer.concat([left, right])));
      }
      levels.push(next);
    }

    const auxMerkleRoot = levels[levels.length - 1][0];

    // Compute branch path for every active chain (used by the AuxPoW proof).
    // sideMask bit i is set when our slot is the right child at level i,
    // matching the daemon's verification routine.
    const branches = new Map();
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].symbol === null) continue;
      const branch = [];
      let sideMask = 0;
      let idx = i;
      for (let lvl = 0; lvl < levels.length - 1; lvl++) {
        const isRight = (idx & 1) === 1;
        const siblingIdx = isRight ? idx - 1 : idx + 1;
        const siblingHash = siblingIdx < levels[lvl].length
          ? levels[lvl][siblingIdx]
          : levels[lvl][idx]; // odd-length: pair with self
        branch.push(siblingHash);
        if (isRight) sideMask |= (1 << lvl);
        idx = idx >>> 1;
      }
      branches.set(slots[i].symbol, { branch, sideMask, slot: i });
    }

    poolLogger.emit('AUX_001', { chains: auxBlocks.length, merkleSize });

    return {
      auxMerkleRoot,
      auxMerkleSize: merkleSize,
      merkleNonce,
      chainSlots: slots,
      branches,
    };
  }

  /**
   * Get the coinbase script fragment for merged mining.
   * This is embedded in the LTC coinbase scriptSig.
   *
   * Format: MERGED_MINING_HEADER (4 bytes) + auxMerkleRoot (32 bytes) +
   *         merkleSize (4 bytes LE) + merkleNonce (4 bytes LE)
   *
   * @returns {Buffer|null}
   */
  getCoinbaseAuxData() {
    const tree = this.buildAuxMerkleTree();
    if (!tree) return null;

    const buf = Buffer.alloc(44); // 4 + 32 + 4 + 4
    let offset = 0;

    // Magic bytes: fabe6d6d
    MERGED_MINING_HEADER.copy(buf, offset);
    offset += 4;

    // Aux merkle root
    tree.auxMerkleRoot.copy(buf, offset);
    offset += 32;

    // Merkle tree size
    buf.writeUInt32LE(tree.auxMerkleSize, offset);
    offset += 4;

    // Merkle nonce
    buf.writeUInt32LE(tree.merkleNonce, offset);

    return buf;
  }

  // ═══════════════════════════════════════════════════════
  // SHARE CHECKING & AUX BLOCK SUBMISSION
  // ═══════════════════════════════════════════════════════

  /**
   * Check a share against all auxiliary chain targets.
   * If the share meets any aux chain's difficulty,
   * submit the aux block automatically.
   *
   * @param {Buffer} headerHash - Scrypt hash of the parent block header
   * @param {Buffer} parentHeader - 80-byte parent block header
   * @param {string} coinbaseHex - Serialized coinbase transaction
   * @param {Buffer[]} coinbaseMerkleBranch - Merkle branch from coinbase to root
   * @param {object} client - Stratum client for logging
   */
  async checkAuxChains(headerHash, parentHeader, coinbaseHex, coinbaseMerkleBranch, client) {
    // Build the aux merkle tree once for this share so every chain's proof
    // is derived from the same tree the parent coinbase was committed to.
    const tree = this.buildAuxMerkleTree();

    for (const [symbol, auxBlock] of this.auxBlocks) {
      const chain = this.chains.get(symbol);
      if (!chain || !chain.enabled || !chain.currentBlock) continue;

      try {
        // Compare hash against aux chain target
        const auxTarget = safeHexToBuffer(auxBlock.target, `auxBlock(${symbol}).target`, 32);
        const hashReversed = Buffer.from(headerHash).reverse();

        if (hashReversed.compare(auxTarget) <= 0) {
          log.info({
            coin: symbol,
            worker: client?.workerName,
            hash: reverseBuffer(headerHash).toString('hex').substring(0, 16) + '...',
          }, `🎉 AUX BLOCK FOUND: ${symbol}!`);

          const branchInfo = tree && tree.branches ? tree.branches.get(symbol) : null;
          if (!branchInfo) {
            log.warn({ coin: symbol }, 'Aux chain not present in current merkle tree — cannot prove inclusion');
            continue;
          }

          // Build and submit the AuxPoW proof
          await this._submitAuxBlock(symbol, chain, parentHeader, coinbaseHex, coinbaseMerkleBranch, branchInfo);
        }
      } catch (err) {
        log.error({ coin: symbol, err: err.message }, 'Aux chain check error');
      }
    }
  }

  /**
   * Submit a solved auxiliary block
   */
  async _submitAuxBlock(symbol, chain, parentHeader, coinbaseHex, coinbaseMerkleBranch, auxBranchInfo) {
    // Redis distributed lock — prevent duplicate submissions for same aux block
    const lockKey = `auxpow:lock:${symbol}`;
    if (this.redis) {
      try {
        const acquired = await this.redis.set(lockKey, '1', 'EX', 5, 'NX');
        if (!acquired) {
          log.debug({ coin: symbol }, 'AuxPoW submission locked — skipping duplicate');
          return;
        }
      } catch (err) {
        log.warn({ coin: symbol, err: err.message }, 'AuxPoW lock acquire failed — proceeding without lock');
        poolLogger.emit('AUX_004', { chain: symbol, error: err.message });
      }
    }

    try {
      const auxBlock = chain.currentBlock;

      // Build the AuxPoW proof
      // The AuxPoW consists of:
      //   - Coinbase transaction
      //   - Coinbase merkle branch (branch to parent block merkle root)
      //   - Aux merkle branch (branch to aux merkle root in coinbase)
      //   - Parent block header

      const auxPowHex = this._buildAuxPowProof(
        parentHeader,
        coinbaseHex,
        coinbaseMerkleBranch,
        auxBranchInfo
      );

      // Submit to aux daemon: submitauxblock(blockhash, auxpow)
      const result = await chain.rpc.submitAuxBlock(auxBlock.hash, auxPowHex);

      if (result === null || result === undefined || result === true) {
        chain.blocksFound++;

        log.info({
          coin: symbol,
          hash: auxBlock.hash,
          blocksFound: chain.blocksFound,
        }, `✅ ${symbol} aux block accepted!`);
        poolLogger.emit('AUX_002', { chain: symbol, hash: auxBlock.hash, blocksFound: chain.blocksFound });

        this.emit('auxBlockFound', symbol, auxBlock, chain);

        // Immediately request next aux block
        await this._refreshAuxBlock(symbol, chain);
      } else {
        log.warn({
          coin: symbol,
          result,
          hash: auxBlock.hash,
        }, `❌ ${symbol} aux block rejected`);
        poolLogger.emit('AUX_003', { chain: symbol, hash: auxBlock.hash, reason: result });

        this.emit('auxBlockRejected', symbol, auxBlock, result);
      }
    } catch (err) {
      log.error({ coin: symbol, err: err.message }, 'Aux block submission failed');
    } finally {
      // Release distributed lock
      if (this.redis) {
        this.redis.del(lockKey).catch(() => {});
      }
    }
  }

  /**
   * Build the AuxPoW proof hex string for submission.
   *
   * @param {Buffer|string} parentHeader   - 80-byte parent block header
   * @param {string}        coinbaseHex    - serialized coinbase transaction (hex)
   * @param {Buffer[]}      coinbaseMerkleBranch
   * @param {{branch: Buffer[], sideMask: number, slot: number}|null} auxBranchInfo
   *        - per-chain inclusion proof from buildAuxMerkleTree(); null/empty
   *          means single-chain (branch is empty, sideMask is 0)
   */
  _buildAuxPowProof(parentHeader, coinbaseHex, coinbaseMerkleBranch, auxBranchInfo) {
    const parts = [];

    // Coinbase transaction (serialized)
    parts.push(safeHexToBuffer(coinbaseHex, 'coinbaseHex'));

    // Coinbase merkle branch
    const branchCount = coinbaseMerkleBranch ? coinbaseMerkleBranch.length : 0;
    const countBuf = Buffer.alloc(4);
    countBuf.writeUInt32LE(branchCount);
    parts.push(countBuf);

    if (coinbaseMerkleBranch) {
      for (const hash of coinbaseMerkleBranch) {
        parts.push(Buffer.isBuffer(hash) ? hash : Buffer.from(hash, 'hex'));
      }
    }

    // Coinbase side mask — coinbase is always index 0 in the parent block
    const sideMask = Buffer.alloc(4);
    sideMask.writeUInt32LE(0);
    parts.push(sideMask);

    // Aux merkle branch (real, derived from buildAuxMerkleTree)
    const auxBranch = auxBranchInfo && auxBranchInfo.branch ? auxBranchInfo.branch : [];
    const auxSideMaskValue = auxBranchInfo && typeof auxBranchInfo.sideMask === 'number'
      ? auxBranchInfo.sideMask
      : 0;

    const auxBranchCount = Buffer.alloc(4);
    auxBranchCount.writeUInt32LE(auxBranch.length);
    parts.push(auxBranchCount);

    for (const hash of auxBranch) {
      parts.push(Buffer.isBuffer(hash) ? hash : Buffer.from(hash, 'hex'));
    }

    const auxSideMask = Buffer.alloc(4);
    auxSideMask.writeUInt32LE(auxSideMaskValue);
    parts.push(auxSideMask);

    // Parent block header (80 bytes)
    parts.push(Buffer.isBuffer(parentHeader)
      ? parentHeader
      : safeHexToBuffer(parentHeader, 'parentHeader', 80));

    return Buffer.concat(parts).toString('hex');
  }

  // ═══════════════════════════════════════════════════════
  // UTILITY
  // ═══════════════════════════════════════════════════════

  /**
   * Calculate the slot index for a chain in the aux merkle tree
   * Uses the standard algorithm from the merged mining spec
   */
  _getAuxSlot(chainId, merkleSize, merkleNonce) {
    let rand = merkleNonce;
    rand = Math.imul(rand, 1103515245) + 12345;
    rand = (rand + chainId) >>> 0;
    rand = Math.imul(rand, 1103515245) + 12345;
    return (rand >>> 0) % merkleSize;
  }

  _nextPowerOf2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  /**
   * Get stats for all aux chains
   */
  getStats() {
    const stats = {};
    for (const [symbol, chain] of this.chains) {
      stats[symbol] = {
        name: chain.config.name,
        enabled: chain.enabled,
        connected: !!chain.currentBlock,
        blocksFound: chain.blocksFound,
        currentHash: chain.lastHash ? chain.lastHash.substring(0, 16) + '...' : null,
      };
    }
    return stats;
  }

  /**
   * Get count of active aux chains
   */
  getActiveChainCount() {
    let count = 0;
    for (const [, chain] of this.chains) {
      if (chain.enabled && chain.currentBlock) count++;
    }
    return count;
  }
}

module.exports = AuxPowEngine;
