/**
 * LUXXPOOL — Scrypt Hashing & Difficulty Utilities
 * Core crypto functions for Litecoin/Dogecoin mining
 */

const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════

// Litecoin scrypt parameters: N=1024, r=1, p=1, keyLen=32
const SCRYPT_N = 1024;
const SCRYPT_R = 1;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 32;

// Maximum target (difficulty 1) for scrypt coins
// 0x0000ffff00000000000000000000000000000000000000000000000000000000
const MAX_TARGET = Buffer.from(
  '0000ffff00000000000000000000000000000000000000000000000000000000',
  'hex'
);

const TWO_256 = BigInt('0x10000000000000000000000000000000000000000000000000000000000000000');
const DIFF1_TARGET = BigInt('0x0000ffff00000000000000000000000000000000000000000000000000000000');

// ═══════════════════════════════════════════════════════════
// HASHING
// ═══════════════════════════════════════════════════════════

/**
 * Double SHA-256 hash
 * @param {Buffer} data
 * @returns {Buffer}
 */
function sha256d(data) {
  return crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(data).digest())
    .digest();
}

/**
 * Single SHA-256 hash
 * @param {Buffer} data
 * @returns {Buffer}
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * Scrypt hash for Litecoin proof-of-work
 * Uses Node.js native crypto.scryptSync (N=1024, r=1, p=1)
 * @param {Buffer} input - 80-byte block header
 * @returns {Buffer} 32-byte hash
 */
function scryptHash(input) {
  return crypto.scryptSync(input, input, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * SCRYPT_N * SCRYPT_R,
  });
}

// ═══════════════════════════════════════════════════════════
// DIFFICULTY & TARGET
// ═══════════════════════════════════════════════════════════

/**
 * Convert pool difficulty to target Buffer
 * target = DIFF1_TARGET / difficulty
 * @param {number} difficulty
 * @returns {Buffer} 32-byte target
 */
function difficultyToTarget(difficulty) {
  const target = DIFF1_TARGET / BigInt(Math.floor(difficulty));
  const hex = target.toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

/**
 * Convert target buffer to difficulty number
 * @param {Buffer} target
 * @returns {number}
 */
function targetToDifficulty(target) {
  const targetBig = BigInt('0x' + target.toString('hex'));
  if (targetBig === 0n) return Infinity;
  return Number(DIFF1_TARGET / targetBig);
}

/**
 * Convert network bits (compact target) to target Buffer
 * @param {string} bits - Compact target as hex string (e.g., '1a01cd2d')
 * @returns {Buffer} 32-byte target
 */
function bitsToTarget(bits) {
  const bitsInt = parseInt(bits, 16);
  const exponent = (bitsInt >> 24) & 0xff;
  const mantissa = bitsInt & 0x7fffff;

  let target;
  if (exponent <= 3) {
    target = BigInt(mantissa >> (8 * (3 - exponent)));
  } else {
    target = BigInt(mantissa) << BigInt(8 * (exponent - 3));
  }

  const hex = target.toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

/**
 * Convert network bits to network difficulty
 * @param {string} bits
 * @returns {number}
 */
function bitsToDifficulty(bits) {
  return targetToDifficulty(bitsToTarget(bits));
}

/**
 * Check if a hash meets the target (hash <= target)
 * @param {Buffer} hash
 * @param {Buffer} target
 * @returns {boolean}
 */
function meetsTarget(hash, target) {
  // Compare reversed (little-endian hash vs big-endian target)
  const hashReversed = Buffer.from(hash).reverse();
  return hashReversed.compare(target) <= 0;
}

// ═══════════════════════════════════════════════════════════
// MERKLE TREE
// ═══════════════════════════════════════════════════════════

/**
 * Build merkle tree branches from transaction hashes.
 * These are the sibling hashes the miner needs to compute
 * the merkle root from the coinbase hash.
 *
 * The coinbase sits at index 0 of the conceptual tree.
 * At each level, we extract the first element (the sibling
 * of the path from coinbase to root) and pair the rest.
 *
 * @param {Buffer[]} txHashes - Non-coinbase transaction hashes
 * @returns {Buffer[]} Merkle branch (sibling hashes per level)
 */
function buildMerkleBranches(txHashes) {
  if (txHashes.length === 0) return [];

  let currentLevel = [...txHashes];
  const branches = [];

  while (currentLevel.length > 0) {
    // First element at this level is the sibling of the coinbase path
    branches.push(currentLevel[0]);

    if (currentLevel.length <= 1) break;

    // Pair remaining elements to build the next level
    const remaining = currentLevel.slice(1);
    const nextLevel = [];
    for (let i = 0; i < remaining.length; i += 2) {
      const left = remaining[i];
      const right = i + 1 < remaining.length ? remaining[i + 1] : left;
      nextLevel.push(sha256d(Buffer.concat([left, right])));
    }
    currentLevel = nextLevel;
  }

  return branches;
}

/**
 * Calculate merkle root from coinbase hash and branches
 * @param {Buffer} coinbaseHash
 * @param {Buffer[]} branches
 * @returns {Buffer}
 */
function calculateMerkleRoot(coinbaseHash, branches) {
  let hash = coinbaseHash;
  for (const branch of branches) {
    hash = sha256d(Buffer.concat([hash, branch]));
  }
  return hash;
}

// ═══════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════

/**
 * Reverse a buffer byte-order (for hash display)
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function reverseBuffer(buf) {
  const reversed = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) {
    reversed[i] = buf[buf.length - 1 - i];
  }
  return reversed;
}

/**
 * Reverse a hex string byte-order
 * @param {string} hex
 * @returns {string}
 */
function reverseHex(hex) {
  return reverseBuffer(Buffer.from(hex, 'hex')).toString('hex');
}

/**
 * Convert integer to little-endian 4-byte buffer
 * @param {number} n
 * @returns {Buffer}
 */
function intToLE32(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n >>> 0);
  return buf;
}

/**
 * Serialize a number as a Bitcoin varint
 * @param {number} n
 * @returns {Buffer}
 */
function serializeVarInt(n) {
  if (n < 0xfd) {
    return Buffer.from([n]);
  } else if (n <= 0xffff) {
    const buf = Buffer.alloc(3);
    buf[0] = 0xfd;
    buf.writeUInt16LE(n, 1);
    return buf;
  } else if (n <= 0xffffffff) {
    const buf = Buffer.alloc(5);
    buf[0] = 0xfe;
    buf.writeUInt32LE(n, 1);
    return buf;
  } else {
    const buf = Buffer.alloc(9);
    buf[0] = 0xff;
    buf.writeBigUInt64LE(BigInt(n), 1);
    return buf;
  }
}

module.exports = {
  // Hashing
  sha256,
  sha256d,
  scryptHash,

  // Difficulty / Target
  difficultyToTarget,
  targetToDifficulty,
  bitsToTarget,
  bitsToDifficulty,
  meetsTarget,
  MAX_TARGET,
  DIFF1_TARGET,

  // Merkle
  buildMerkleBranches,
  calculateMerkleRoot,

  // Utility
  reverseBuffer,
  reverseHex,
  intToLE32,
  serializeVarInt,
};
