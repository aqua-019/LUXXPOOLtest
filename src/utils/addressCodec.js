/**
 * LUXXPOOL v0.3.1 — Litecoin Address Decoder
 * ═══════════════════════════════════════════════════════════
 * CRITICAL FIX: v0.2.0 used a SHA256 placeholder for address
 * decoding. This module properly decodes Litecoin addresses
 * (Legacy P2PKH, P2SH, and Bech32/Bech32m) into output
 * scripts so coinbase transactions send funds correctly.
 *
 * Without this, mined blocks would burn coins to unspendable
 * outputs — the #1 showstopper in the v0.2.0 audit.
 *
 * Address Formats:
 *   L...  → Legacy P2PKH (version byte 0x30)
 *   M...  → P2SH (version byte 0x32)
 *   ltc1... → Bech32 (Segwit v0) or Bech32m (Segwit v1+)
 *
 * Dogecoin:
 *   D...  → P2PKH (version byte 0x1e)
 */

const crypto = require('crypto');

// Base58 alphabet (Bitcoin/Litecoin standard)
const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Bech32 charset
const BECH32_CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

// ═══════════════════════════════════════════════════════════
// BASE58CHECK DECODE
// ═══════════════════════════════════════════════════════════

function base58Decode(str) {
  let num = 0n;
  for (const ch of str) {
    const idx = BASE58_CHARS.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid Base58 character: ${ch}`);
    num = num * 58n + BigInt(idx);
  }

  // Convert to bytes
  const hex = num.toString(16).padStart(50, '0'); // 25 bytes = 50 hex chars
  const bytes = Buffer.from(hex, 'hex');

  // Leading zeros
  let leadingZeros = 0;
  for (const ch of str) {
    if (ch === '1') leadingZeros++;
    else break;
  }

  const result = Buffer.concat([Buffer.alloc(leadingZeros), bytes]);

  // Verify checksum (last 4 bytes)
  const payload = result.slice(0, -4);
  const checksum = result.slice(-4);
  const hash = crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(payload).digest()
  ).digest();

  if (!hash.slice(0, 4).equals(checksum)) {
    throw new Error('Invalid Base58Check checksum');
  }

  return {
    version: payload[0],
    hash: payload.slice(1),
  };
}

// ═══════════════════════════════════════════════════════════
// BECH32 / BECH32M DECODE
// ═══════════════════════════════════════════════════════════

function bech32Decode(str) {
  const lower = str.toLowerCase();
  const sepIdx = lower.lastIndexOf('1');
  if (sepIdx < 1) throw new Error('Invalid bech32: no separator');

  const hrp = lower.slice(0, sepIdx);
  const dataStr = lower.slice(sepIdx + 1);

  if (dataStr.length < 6) throw new Error('Invalid bech32: too short');

  const data = [];
  for (const ch of dataStr) {
    const idx = BECH32_CHARS.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid bech32 character: ${ch}`);
    data.push(idx);
  }

  // ── Bech32 checksum verification (BIP173 / BIP350) ──
  const BECH32_CONST = 1;      // bech32 (witness v0)
  const BECH32M_CONST = 0x2bc830a3; // bech32m (witness v1+)

  function bech32Polymod(values) {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) {
        if ((top >> i) & 1) chk ^= GEN[i];
      }
    }
    return chk;
  }

  function hrpExpand(hrp) {
    const ret = [];
    for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
    ret.push(0);
    for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
    return ret;
  }

  const checksum = bech32Polymod([...hrpExpand(hrp), ...data]);
  const values = data.slice(0, -6);
  const witnessVersion = values[0];

  // Witness v0 uses bech32, v1+ uses bech32m
  const expectedConst = witnessVersion === 0 ? BECH32_CONST : BECH32M_CONST;
  if (checksum !== expectedConst) {
    throw new Error(`Invalid bech32 checksum (got ${checksum}, expected ${expectedConst})`);
  }

  const witnessProgram = convertBits(values.slice(1), 5, 8, false);

  return {
    hrp,
    witnessVersion,
    witnessProgram: Buffer.from(witnessProgram),
  };
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0;
  let bits = 0;
  const result = [];
  const maxv = (1 << toBits) - 1;

  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) result.push((acc << (toBits - bits)) & maxv);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════
// ADDRESS → OUTPUT SCRIPT
// ═══════════════════════════════════════════════════════════

/**
 * Convert a Litecoin address to its output script (scriptPubKey)
 * @param {string} address - Litecoin address (L..., M..., ltc1...)
 * @returns {Buffer} Output script
 */
function addressToOutputScript(address) {
  if (!address || address.length < 10) {
    throw new Error('Invalid address: too short');
  }

  // Bech32 addresses (ltc1...)
  if (address.toLowerCase().startsWith('ltc1')) {
    const decoded = bech32Decode(address);

    if (decoded.witnessVersion === 0 && decoded.witnessProgram.length === 20) {
      // P2WPKH: OP_0 <20-byte-hash>
      return Buffer.concat([
        Buffer.from([0x00, 0x14]),
        decoded.witnessProgram,
      ]);
    } else if (decoded.witnessVersion === 0 && decoded.witnessProgram.length === 32) {
      // P2WSH: OP_0 <32-byte-hash>
      return Buffer.concat([
        Buffer.from([0x00, 0x20]),
        decoded.witnessProgram,
      ]);
    } else if (decoded.witnessVersion >= 1) {
      // Taproot / future segwit: OP_n <program>
      return Buffer.concat([
        Buffer.from([0x50 + decoded.witnessVersion]),
        Buffer.from([decoded.witnessProgram.length]),
        decoded.witnessProgram,
      ]);
    }

    throw new Error('Unknown bech32 witness program');
  }

  // Base58Check addresses (L..., M...)
  const decoded = base58Decode(address);

  // Version 0x30 (48) = Litecoin P2PKH
  // Version 0x32 (50) = Litecoin P2SH
  // Version 0x1e (30) = Dogecoin P2PKH
  if (decoded.version === 0x30 || decoded.version === 0x1e) {
    // P2PKH: OP_DUP OP_HASH160 <20-byte-hash> OP_EQUALVERIFY OP_CHECKSIG
    return Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]),
      decoded.hash.slice(0, 20),
      Buffer.from([0x88, 0xac]),
    ]);
  }

  if (decoded.version === 0x32 || decoded.version === 0x05) {
    // P2SH: OP_HASH160 <20-byte-hash> OP_EQUAL
    return Buffer.concat([
      Buffer.from([0xa9, 0x14]),
      decoded.hash.slice(0, 20),
      Buffer.from([0x87]),
    ]);
  }

  throw new Error(`Unsupported address version: 0x${decoded.version.toString(16)}`);
}

/**
 * Validate a Litecoin address format
 * @param {string} address
 * @returns {{ valid: boolean, type: string, error?: string }}
 */
function validateAddress(address) {
  try {
    if (!address) return { valid: false, type: 'unknown', error: 'Empty address' };

    if (address.toLowerCase().startsWith('ltc1')) {
      const decoded = bech32Decode(address);
      const type = decoded.witnessVersion === 0 ? 'bech32' : 'bech32m';
      return { valid: true, type };
    }

    const decoded = base58Decode(address);
    if (decoded.version === 0x30) return { valid: true, type: 'p2pkh' };
    if (decoded.version === 0x32) return { valid: true, type: 'p2sh' };

    return { valid: false, type: 'unknown', error: `Unknown version: ${decoded.version}` };
  } catch (err) {
    return { valid: false, type: 'unknown', error: err.message };
  }
}

module.exports = {
  addressToOutputScript,
  validateAddress,
  base58Decode,
  bech32Decode,
};
