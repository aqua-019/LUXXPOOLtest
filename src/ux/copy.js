/**
 * LUXXPOOL — UX Writing System
 * ═══════════════════════════════════════════════════════════
 * Single source of truth for every user-facing string.
 *
 * BRAND VOICE:
 *   Confident, direct, technical but never cold.
 *   LUXXPOOL speaks like a senior engineer who respects
 *   your time — no filler, no marketing fluff, no "oops!".
 *   Clear enough for a first-time miner, precise enough
 *   for an operator running 100 ASICs.
 *
 * TONE LADDER:
 *   Public dashboard  → Welcoming, instructional, encouraging
 *   Private dashboard → Clinical, precise, operational
 *   Stratum errors    → Terse, actionable, no blame
 *   API errors        → Structured, developer-friendly
 *   Security alerts   → Urgent, factual, no alarm theater
 *   Operator logs     → Dense, scannable, emoji-anchored
 *
 * RULES:
 *   - Sentence case everywhere. Never Title Case, never ALL CAPS.
 *   - No exclamation marks in errors. One per celebration max.
 *   - No "please" in errors (wastes space, sounds passive).
 *   - No "oops", "uh oh", "something went wrong" (vague, childish).
 *   - Error messages: state what happened, then what to do.
 *   - Numbers: always formatted (1,847 not 1847, 16.25 GH/s not 16250000000 H/s).
 *   - Addresses: truncate middle (LhXk7...abc), never show full in UI.
 *   - Time: relative ("3m ago") in UI, ISO 8601 in API responses.
 */

// ═══════════════════════════════════════════════════════════
// STRATUM PROTOCOL MESSAGES
// These are what mining firmware displays. Keep under 40 chars.
// Miners see: "Share rejected: [message]"
// ═══════════════════════════════════════════════════════════

const STRATUM = {
  // Error codes follow the Stratum v1 spec:
  // 20 = Other/unknown
  // 21 = Job not found (stale)
  // 22 = Duplicate share
  // 23 = Low difficulty
  // 24 = Unauthorized
  // 25 = Not subscribed

  errors: {
    JOB_NOT_FOUND:    { code: 21, message: 'Stale job — new work available' },
    DUPLICATE_SHARE:  { code: 22, message: 'Duplicate share' },
    LOW_DIFFICULTY:   { code: 23, message: 'Share below target difficulty' },
    INVALID_NTIME:    { code: 20, message: 'Invalid ntime — check miner clock' },
    INVALID_PARAMS:   { code: 20, message: 'Missing share parameters' },
    UNAUTHORIZED:     { code: 24, message: 'Worker not authorized' },
    NOT_SUBSCRIBED:   { code: 25, message: 'Subscribe before submitting' },
    UNKNOWN_METHOD:   { code: 20, message: 'Unsupported stratum method' },
    BANNED:           { code: 24, message: 'Connection blocked' },
    SECURITY:         { code: 24, message: 'Connection blocked — policy' },
    INTERNAL:         { code: 20, message: 'Pool error — try reconnecting' },
  },

  // Miner-facing pool identification
  subscribe: {
    poolName: 'LUXXPOOL',
    version: '0.5.2',
    motd: 'LUXXPOOL — Scrypt multi-coin merged mining',
  },
};

// ═══════════════════════════════════════════════════════════
// API RESPONSE MESSAGES
// These appear in JSON responses. Developer-facing.
// Format: { error: "message", code: "ERROR_CODE" }
// ═══════════════════════════════════════════════════════════

const API = {
  errors: {
    NOT_FOUND:        { status: 404, error: 'Resource not found', code: 'NOT_FOUND' },
    MINER_NOT_FOUND:  { status: 404, error: 'No miner found for this address', code: 'MINER_NOT_FOUND' },
    MINER_NOT_TRACKED:{ status: 404, error: 'Address not yet tracked — submit shares first', code: 'MINER_NOT_TRACKED' },
    INTERNAL:         { status: 500, error: 'Internal pool error — retry in 30s', code: 'INTERNAL_ERROR' },
    DAEMON_OFFLINE:   { status: 503, error: 'Blockchain daemon unreachable — pool degraded', code: 'DAEMON_OFFLINE' },
    VALIDATION:       { status: 400, error: 'Missing or invalid parameters', code: 'VALIDATION_ERROR' },
    RATE_LIMITED:     { status: 429, error: 'Rate limit exceeded — slow down', code: 'RATE_LIMITED' },
  },

  // Field-specific validation errors
  validation: {
    IP_REQUIRED:       'Provide an IP address or CIDR (e.g., 203.0.113.50 or 10.0.0.0/24)',
    ADDRESS_REQUIRED:  'Provide a Litecoin address (L..., M..., or ltc1...)',
    COIN_REQUIRED:     'Specify coin symbol (LTC, DOGE, BELLS, etc.)',
    COIN_UNKNOWN:      (coin) => `Unknown coin: ${coin} — see /api/v1/coins for supported list`,
    MAX_INVALID:       'Capacity must be at least 1',
    COIN_AND_ADDRESS:  'Both coin and coinAddress are required',
  },
};

// ═══════════════════════════════════════════════════════════
// SECURITY ALERT COPY
// Private dashboard + operator logs. Factual, not theatrical.
// ═══════════════════════════════════════════════════════════

const SECURITY = {
  alerts: {
    BWH_SUSPECTED: {
      title: 'Block withholding pattern detected',
      detail: (data) => `${data.address} — ${data.totalShares} shares, ${data.blocksFound} blocks over ${Math.floor(data.timeActive/3600)}h. Expected block rate significantly higher.`,
      severity: 'warning',
      action: 'Monitor — auto-resolves if miner finds a block',
    },
    TIMING_ANOMALY: {
      title: 'Unnatural share timing',
      detail: (data) => `${data.address} — coefficient of variation ${data.cv.toFixed(3)}. Consistent intervals suggest automated replay.`,
      severity: 'warning',
      action: 'Investigate miner software or network proxy',
    },
    SHARE_FLOOD: {
      title: 'Share submission flood',
      detail: (data) => `${data.ip} — ${data.sharesPerSecond} shares/sec (limit: 10). Likely faulty firmware or intentional attack.`,
      severity: 'critical',
      action: 'Auto-banned. Check if fleet IP was affected.',
    },
    NTIME_MANIPULATION: {
      title: 'Clock drift or ntime tampering',
      detail: (data) => `${data.ip} — ntime deviates ${data.deviation}s from server. May indicate time-warp attempt.`,
      severity: 'critical',
      action: 'Auto-banned. Legitimate miners: sync NTP.',
    },
    VARDIFF_GAMING: {
      title: 'Difficulty manipulation attempt',
      detail: (data) => `${data.ip} — difficulty swung ${data.minDiff} to ${data.maxDiff} (${Math.round(data.maxDiff/data.minDiff)}x range). Intentional slow-then-burst pattern.`,
      severity: 'medium',
      action: 'Monitor — VarDiff auto-corrects over time',
    },
    SYBIL_SUSPECTED: {
      title: 'Multiple addresses from single IP',
      detail: (data) => `${data.ip} — ${data.addressCount} distinct addresses. May indicate Sybil or shared proxy.`,
      severity: 'medium',
      action: 'Check if this IP is a shared facility. Add to fleet whitelist if legitimate.',
    },
    HASHRATE_OSCILLATION: {
      title: 'Hashrate instability',
      detail: (data) => `${data.ip} — ${data.ratio.toFixed(1)}x rate change. Possible pool-hopping or intermittent hardware.`,
      severity: 'low',
      action: 'Informational — common with unstable connections',
    },
  },

  // Security layer descriptions (private dashboard)
  layers: {
    L1: {
      name: 'Mining cookies',
      status: 'Per-connection HMAC secret',
      defends: 'MitM share hijacking (BiteCoin, WireGhost)',
    },
    L2: {
      name: 'Share fingerprinting',
      status: 'Statistical block withholding detection',
      defends: 'BWH, FAW, infiltrated selfish mining',
    },
    L3: {
      name: 'Behavioral analysis',
      status: 'Real-time anomaly detection on every share',
      defends: 'Floods, ntime manipulation, vardiff gaming, Sybil',
    },
  },
};

// ═══════════════════════════════════════════════════════════
// OPERATOR LOG MESSAGES
// What the server admin sees in stdout/journalctl.
// Emoji anchors for quick visual scanning.
// ═══════════════════════════════════════════════════════════

const OPS = {
  startup: {
    banner:           'LUXXPOOL v0.5.2 — starting',
    configLoaded:     'Configuration loaded',
    dbConnected:      'PostgreSQL connected',
    dbMigrated:       'Migrations complete',
    redisConnected:   'Redis connected',
    redisDegraded:    'Redis offline — degraded mode (in-memory fallback)',
    ltcConnected:     (info) => `Litecoin daemon connected — chain: ${info.chain}, height: ${info.blocks}`,
    ltcFailed:        'Litecoin daemon unreachable — cannot start',
    auxConnected:     (sym) => `${sym} daemon connected`,
    auxOffline:       (sym) => `${sym} daemon offline — merged mining disabled for this coin`,
    securityActive:   'Security engine active — all 3 layers wired',
    fleetReady:       (n) => `Fleet manager ready — ${n} IPs whitelisted`,
    stratumListening: (port) => `Stratum listening on :${port}`,
    sslListening:     (port) => `SSL stratum listening on :${port}`,
    soloListening:    (port) => `Solo mining listening on :${port}`,
    apiListening:     (port) => `API server listening on :${port}`,
    ready:            'Pool is running',
  },

  mining: {
    newTemplate:      (h, txCount) => `New template — height ${h}, ${txCount} txs`,
    jobBroadcast:     (jobId, count) => `Job ${jobId} → ${count} miners`,
    blockFound:       (h, worker, reward) => `Block found! Height ${h} by ${worker} — ${reward} LTC`,
    blockAccepted:    (h) => `Block ${h} accepted by network`,
    blockRejected:    (h, reason) => `Block ${h} rejected — ${reason}`,
    blockConfirmed:   (coin, h) => `${coin} block ${h} confirmed — eligible for payout`,
    blockOrphaned:    (coin, h) => `${coin} block ${h} orphaned — removed from round`,
    auxBlockFound:    (sym, h) => `${sym} aux block found at height ${h}`,
  },

  connection: {
    minerConnect:     (ip, fleet) => `Miner connected from ${ip}${fleet ? ' [fleet]' : ''}`,
    minerAuth:        (worker, fleet) => `${worker} authorized${fleet ? ' [fleet]' : ''}`,
    minerDisconnect:  (worker, uptime) => `${worker} disconnected after ${uptime}`,
    connectionFlood:  (ip) => `Connection flood from ${ip} — rejected`,
    banned:           (ip, reason) => `Banned ${ip} — ${reason}`,
  },

  payment: {
    cycleStart:       'Payment cycle started',
    calculated:       (miners, total, coin) => `${coin} payouts: ${miners} miners, ${total} ${coin} total`,
    sent:             (txid, count, coin) => `${coin} payment sent — txid: ${txid.substring(0,16)}..., ${count} recipients`,
    failed:           (coin, err) => `${coin} payment failed — ${err}`,
  },

  shutdown: {
    starting:         (signal) => `Shutdown signal received (${signal})`,
    complete:         'Shutdown complete',
  },
};

// ═══════════════════════════════════════════════════════════
// PUBLIC DASHBOARD COPY
// Welcoming, instructional, encouraging.
// ═══════════════════════════════════════════════════════════

const PUBLIC = {
  nav: {
    stats:    'Pool stats',
    connect:  'Connect',
    faq:      'Setup guide',
    lookup:   'Miner lookup',
  },

  stats: {
    poolHashrate:     'Pool hashrate',
    activeMiners:     'Active miners',
    networkDiff:      'Network difficulty',
    coinsMining:      'Coins mining',
    poolFee:          'Pool fee',
    hashrate24h:      'Pool hashrate — 24h',
    mergedMining:     'Merged mining — earn all coins automatically',
    recentBlocks:     'Recent blocks',
  },

  connect: {
    heading:          'Connect your miner',
    poolMining:       'Pool mining',
    poolDesc:         'Share rewards with all miners (PPLNS). Most consistent payouts.',
    soloMining:       'Solo mining',
    soloDesc:         'Keep 99% of any block you find. Higher variance, bigger individual payouts.',
    merged:           'Merged mining — automatic',
    mergedDesc:       'Connect once, mine LTC, earn all auxiliary coins automatically via AuxPoW. No extra setup.',
    workerFormat:     'Your LTC address, then a dot, then a name for this miner.',
    passwordNote:     'Any value works. Most miners use x.',
    clickToCopy:      'Click to copy',
    copied:           'Copied',
  },

  faq: {
    heading:          'How to mine Litecoin with LUXXPOOL',
    subheading:       'Setup guide for Scrypt ASIC miners — Antminer L9, L7, ElphaPex, VOLCMINER, and all Scrypt hardware.',
    walletTitle:      'Get a Litecoin wallet',
    walletWarning:    'Use a wallet you control. Never use an exchange deposit address for mining payouts.',
    hardwareTitle:    'Hardware requirements',
    hardwareNote:     'You need a Scrypt ASIC miner. GPU and CPU mining are not profitable for Litecoin.',
    powerNote:        'You also need a 240V 30A dedicated circuit, an ethernet cable (not WiFi), and adequate ventilation.',
    configureTitle:   'Configure your miner',
    configureSuccess: 'Click Save & Apply. Your miner restarts and begins hashing within 1–2 minutes.',
    mergedTitle:      'Merged mining — 10 coins at once',
    mergedExplain:    'LUXXPOOL uses AuxPoW to mine LTC and up to 9 auxiliary Scrypt coins simultaneously. Zero extra configuration, zero extra power.',
    mergedWalletNote: 'Register wallet addresses for each auxiliary coin to receive rewards. Without registration, rewards are held until you register.',
    poolVsSoloTitle:  'Pool mining vs solo mining',
    payoutTitle:      'Payouts',
    troubleTitle:     'Troubleshooting',
  },

  lookup: {
    heading:          'Miner lookup',
    placeholder:      'Enter your Litecoin address',
    button:           'Look up',
    empty:            'Enter your mining address to see hashrate, workers, shares, and payments.',
    notFound:         'No mining activity found for this address. Connect your miner first.',
  },

  footer: {
    left:             'LUXXPOOL — Christina Lake, BC',
    right:            'Scrypt multi-coin merged mining',
  },
};

// ═══════════════════════════════════════════════════════════
// PRIVATE DASHBOARD COPY
// Clinical, precise, operational.
// ═══════════════════════════════════════════════════════════

const PRIVATE = {
  nav: {
    command:   'Command',
    security:  'Security',
    fleet:     'Fleet',
    connect:   'Connect',
  },

  command: {
    poolHashrate:     'Pool hashrate',
    fleetHashrate:    'Fleet hashrate',
    publicHashrate:   'Public hashrate',
    activeMiners:     'Active miners',
    networkDiff:      'Network difficulty',
    chainsActive:     'Chains active',
    blocksFound:      'Blocks found',
    securityStatus:   'Security',
    securityClear:    'Clear',
    securityAlert:    (n) => `${n} alert${n !== 1 ? 's' : ''}`,
    hashrate24h:      'Hashrate — 24h',
    mergedChains:     'Merged mining — auxiliary chains',
    blockEvents:      'Block events',
  },

  security: {
    heading:          'Security engine — 3 layers',
    threatModel:      'Threat model — covered vectors',
    recentEvents:     'Recent security events',
    noEvents:         'No security events',
  },

  fleet: {
    heading:          'Fleet management',
    overview:         'Fleet vs public',
    fleetMiners:      'Fleet miners',
    publicMiners:     'Public miners',
    addIp:            'Add IP to fleet',
    addAddress:       'Add address to fleet',
    capacity:         'Fleet capacity',
    config:           'Fleet configuration',
  },
};

// ═══════════════════════════════════════════════════════════
// SHARED LABELS
// ═══════════════════════════════════════════════════════════

const LABELS = {
  // Coin table headers
  coin:             'Coin',
  symbol:           'Symbol',
  role:             'Role',
  blockReward:      'Block reward',
  blockTime:        'Block time',
  status:           'Status',

  // Miner table headers
  worker:           'Worker',
  hashrate:         'Hashrate',
  shares:           'Shares',
  lastSeen:         'Last seen',
  difficulty:       'Difficulty',
  uptime:           'Uptime',
  rejectRate:       'Reject rate',

  // Block table headers
  height:           'Height',
  hash:             'Hash',
  reward:           'Reward',
  confirmations:    'Confirmations',
  foundBy:          'Found by',
  foundAt:          'Found',

  // Payment table headers
  address:          'Address',
  amount:           'Amount',
  txid:             'Transaction',
  sentAt:           'Sent',

  // Block statuses
  confirmed:        'Confirmed',
  pending:          'Pending',
  orphaned:         'Orphaned',
  mining:           'Mining',

  // Connection statuses
  online:           'Online',
  offline:          'Offline',
  degraded:         'Degraded',
  live:             'Live',

  // Fleet classification
  fleet:            'Fleet',
  public:           'Public',

  // Time
  ago:              'ago',
  never:            'Never',
};

module.exports = {
  STRATUM,
  API,
  SECURITY,
  OPS,
  PUBLIC,
  PRIVATE,
  LABELS,
};
