/**
 * LUXXPOOL — Multi-Coin Scrypt Merged Mining Configuration
 * ═══════════════════════════════════════════════════════════
 * Litecoin (parent chain) + 9 Auxiliary PoW chains
 * All coins share the Scrypt algorithm (N=1024, r=1, p=1)
 *
 * AuxPoW Flow:
 *   1. Pool calls createauxblock on each aux daemon
 *   2. Aux block hashes are assembled into an auxiliary merkle tree
 *   3. Aux merkle root is embedded in the LTC coinbase transaction
 *   4. When a share meets an aux chain's difficulty → submitauxblock
 *   5. Miner earns LTC + all aux coin rewards simultaneously
 */

const SCRYPT_COINS = {
  // ═══════════════════════════════════════════════════════
  // PRIMARY CHAIN
  // ═══════════════════════════════════════════════════════
  LTC: {
    name: 'Litecoin',
    symbol: 'LTC',
    algorithm: 'scrypt',
    role: 'parent',
    chainId: null,
    blockTime: 150,            // 2.5 minutes
    blockReward: 6.25,         // Post-halving (Aug 2023)
    confirmations: 100,        // Coinbase maturity
    defaultPort: 9332,         // RPC port
    p2pPort: 9333,
    addressPrefix: ['L', 'M', 'ltc1'],
    explorerUrl: 'https://blockchair.com/litecoin',
    enabled: true,
  },

  // ═══════════════════════════════════════════════════════
  // AUXILIARY CHAINS (AuxPoW merged mining)
  // ═══════════════════════════════════════════════════════
  DOGE: {
    name: 'Dogecoin',
    symbol: 'DOGE',
    algorithm: 'scrypt',
    role: 'auxiliary',
    chainId: 0x0062,           // Dogecoin AuxPoW chain ID
    blockTime: 60,             // 1 minute
    blockReward: 10000,        // Fixed, no more halvings
    confirmations: 40,
    defaultPort: 22555,
    p2pPort: 22556,
    addressPrefix: ['D'],
    explorerUrl: 'https://blockchair.com/dogecoin',
    payoutThreshold: 40,
    enabled: true,
  },

  BELLS: {
    name: 'Bellscoin',
    symbol: 'BELLS',
    algorithm: 'scrypt',
    role: 'auxiliary',
    chainId: 0x0003,
    blockTime: 60,
    blockReward: 'random',     // Random reward mechanism
    confirmations: 20,
    defaultPort: 19918,
    p2pPort: 19919,
    addressPrefix: ['B'],
    explorerUrl: 'https://bells.quark.blue',
    payoutThreshold: 1,
    enabled: true,
  },

  LKY: {
    name: 'Luckycoin',
    symbol: 'LKY',
    algorithm: 'scrypt',
    role: 'auxiliary',
    chainId: 0x0004,
    blockTime: 60,
    blockReward: 'halving',    // Has halving schedule
    confirmations: 20,
    defaultPort: 9917,
    p2pPort: 9918,
    addressPrefix: ['L'],
    explorerUrl: null,
    payoutThreshold: 0.1,
    enabled: true,
  },

  PEP: {
    name: 'Pepecoin',
    symbol: 'PEP',
    algorithm: 'scrypt',
    role: 'auxiliary',
    chainId: 0x0005,
    blockTime: 60,
    blockReward: 'halving',
    confirmations: 20,
    defaultPort: 33874,
    p2pPort: 33873,
    addressPrefix: ['P'],
    explorerUrl: null,
    payoutThreshold: 20000,
    enabled: true,
  },

  JKC: {
    name: 'Junkcoin',
    symbol: 'JKC',
    algorithm: 'scrypt',
    role: 'auxiliary',
    chainId: 0x0006,
    blockTime: 60,
    blockReward: 'halving',
    confirmations: 20,
    defaultPort: 9771,
    p2pPort: 9772,
    addressPrefix: ['J'],
    explorerUrl: null,
    payoutThreshold: 5,
    enabled: true,
  },

  DINGO: {
    name: 'Dingocoin',
    symbol: 'DINGO',
    algorithm: 'scrypt',
    role: 'auxiliary',
    chainId: 0x0007,
    blockTime: 60,
    blockReward: 'variable',
    confirmations: 20,
    defaultPort: 34646,
    p2pPort: 33117,
    addressPrefix: ['D'],
    explorerUrl: 'https://explorer.dingocoin.com',
    payoutThreshold: 1000,
    enabled: true,
  },

  SHIC: {
    name: 'Shibacoin',
    symbol: 'SHIC',
    algorithm: 'scrypt',
    role: 'auxiliary',
    chainId: 0x0008,
    blockTime: 60,
    blockReward: 'halving',    // 6 halving events
    confirmations: 20,
    defaultPort: 22888,
    p2pPort: 22889,
    addressPrefix: ['S'],
    explorerUrl: null,
    payoutThreshold: 40000,
    enabled: true,
  },

  TRMP: {
    name: 'TrumPOW',
    symbol: 'TRMP',
    algorithm: 'scrypt',
    role: 'auxiliary',
    chainId: 0x0009,
    blockTime: 60,
    blockReward: 'variable',
    confirmations: 20,
    defaultPort: 17710,
    p2pPort: 17711,
    addressPrefix: ['T'],
    explorerUrl: null,
    payoutThreshold: 400000,
    enabled: false,            // Enable when node available
  },

  CRC: {
    name: 'CraftCoin',
    symbol: 'CRC',
    algorithm: 'scrypt',
    role: 'auxiliary',
    chainId: 0x000a,
    blockTime: 60,
    blockReward: 'variable',
    confirmations: 20,
    defaultPort: 14832,
    p2pPort: 14833,
    addressPrefix: ['C'],
    explorerUrl: null,
    payoutThreshold: 1,
    enabled: false,            // Enable when node available
  },
};

/**
 * Get all enabled coins
 */
function getEnabledCoins() {
  return Object.entries(SCRYPT_COINS)
    .filter(([, coin]) => coin.enabled)
    .reduce((acc, [key, coin]) => ({ ...acc, [key]: coin }), {});
}

/**
 * Get all enabled auxiliary chains
 */
function getAuxChains() {
  return Object.entries(SCRYPT_COINS)
    .filter(([, coin]) => coin.role === 'auxiliary' && coin.enabled)
    .reduce((acc, [key, coin]) => ({ ...acc, [key]: coin }), {});
}

/**
 * Get the parent chain config
 */
function getParentChain() {
  return SCRYPT_COINS.LTC;
}

module.exports = {
  SCRYPT_COINS,
  getEnabledCoins,
  getAuxChains,
  getParentChain,
};
