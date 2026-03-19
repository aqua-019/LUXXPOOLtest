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
const { sha256d, reverseBuffer, reverseHex } = require('../utils/hashing');
const RpcClient = require('./rpcClient');
const { getAuxChains } = require('../../config/coins');

const log = createLogger('auxpow');

// Merged mining magic bytes (marks the aux merkle root in coinbase)
const MERGED_MINING_HEADER = Buffer.from('fabe6d6d', 'hex');

class AuxPowEngine extends EventEmitter {
  /**
   * @param {object} auxConfigs - Map of symbol → { host, port, user, password, address }
   */
  constructor(auxConfigs = {}) {
    super();

    this.chains = new Map();     // symbol → { rpc, config, currentBlock, ... }
    this.auxBlocks = new Map();  // symbol → { hash, target, chainid }
    this.pollInterval = null;

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
    const merkleSize = this._nextPowerOf2(Math.max(auxBlocks.length, 2));
    const merkleNonce = 0; // Standard merged mining nonce

    // Allocate slots for each chain based on chain ID
    const slots = new Array(merkleSize).fill(null);

    for (const [symbol, auxBlock] of auxBlocks) {
      const slot = this._getAuxSlot(auxBlock.chainId, merkleSize, merkleNonce);

      if (slots[slot] !== null) {
        log.warn({
          coin: symbol,
          slot,
          existing: slots[slot].symbol,
        }, 'Aux merkle slot collision — skipping');
        continue;
      }

      slots[slot] = {
        symbol,
        hash: Buffer.from(auxBlock.hash, 'hex'),
      };
    }

    // Fill empty slots with zero hashes
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] === null) {
        slots[i] = { symbol: null, hash: Buffer.alloc(32) };
      }
    }

    // Build the merkle tree
    let level = slots.map(s => s.hash);
    const branches = [];

    while (level.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = i + 1 < level.length ? level[i + 1] : left;
        nextLevel.push(sha256d(Buffer.concat([left, right])));
      }
      level = nextLevel;
    }

    const auxMerkleRoot = level[0];

    return {
      auxMerkleRoot,
      auxMerkleSize: merkleSize,
      merkleNonce,
      chainSlots: slots,
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
    for (const [symbol, auxBlock] of this.auxBlocks) {
      const chain = this.chains.get(symbol);
      if (!chain || !chain.enabled || !chain.currentBlock) continue;

      try {
        // Compare hash against aux chain target
        const auxTarget = Buffer.from(auxBlock.target, 'hex');
        const hashReversed = Buffer.from(headerHash).reverse();

        if (hashReversed.compare(auxTarget) <= 0) {
          log.info({
            coin: symbol,
            worker: client?.workerName,
            hash: reverseBuffer(headerHash).toString('hex').substring(0, 16) + '...',
          }, `🎉 AUX BLOCK FOUND: ${symbol}!`);

          // Build and submit the AuxPoW proof
          await this._submitAuxBlock(symbol, chain, parentHeader, coinbaseHex, coinbaseMerkleBranch);
        }
      } catch (err) {
        log.error({ coin: symbol, err: err.message }, 'Aux chain check error');
      }
    }
  }

  /**
   * Submit a solved auxiliary block
   */
  async _submitAuxBlock(symbol, chain, parentHeader, coinbaseHex, coinbaseMerkleBranch) {
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
        coinbaseMerkleBranch
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

        this.emit('auxBlockFound', symbol, auxBlock, chain);

        // Immediately request next aux block
        await this._refreshAuxBlock(symbol, chain);
      } else {
        log.warn({
          coin: symbol,
          result,
          hash: auxBlock.hash,
        }, `❌ ${symbol} aux block rejected`);

        this.emit('auxBlockRejected', symbol, auxBlock, result);
      }
    } catch (err) {
      log.error({ coin: symbol, err: err.message }, 'Aux block submission failed');
    }
  }

  /**
   * Build the AuxPoW proof hex string for submission
   */
  _buildAuxPowProof(parentHeader, coinbaseHex, coinbaseMerkleBranch) {
    const parts = [];

    // Coinbase transaction (serialized)
    parts.push(Buffer.from(coinbaseHex, 'hex'));

    // Block hash (parent header double-SHA256)
    // Not needed in the proof itself — it's the parent block hash

    // Coinbase merkle branch
    // Number of hashes
    const branchCount = coinbaseMerkleBranch ? coinbaseMerkleBranch.length : 0;
    const countBuf = Buffer.alloc(4);
    countBuf.writeUInt32LE(branchCount);
    parts.push(countBuf);

    // Branch hashes
    if (coinbaseMerkleBranch) {
      for (const hash of coinbaseMerkleBranch) {
        parts.push(Buffer.isBuffer(hash) ? hash : Buffer.from(hash, 'hex'));
      }
    }

    // Branch side mask (bitmask of left/right positions)
    const sideMask = Buffer.alloc(4);
    sideMask.writeUInt32LE(0); // Standard: coinbase is always index 0
    parts.push(sideMask);

    // Aux merkle branch (for the specific chain)
    // For single-chain merged mining, this is empty
    const auxBranchCount = Buffer.alloc(4);
    auxBranchCount.writeUInt32LE(0);
    parts.push(auxBranchCount);

    // Aux branch side mask
    const auxSideMask = Buffer.alloc(4);
    auxSideMask.writeUInt32LE(0);
    parts.push(auxSideMask);

    // Parent block header (80 bytes)
    parts.push(Buffer.isBuffer(parentHeader) ? parentHeader : Buffer.from(parentHeader, 'hex'));

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
