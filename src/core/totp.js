'use strict';

const crypto = require('node:crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode an RFC 4648 Base32 secret (case-insensitive, ignores spaces/hyphens/padding).
 */
function base32Decode(input) {
  const cleaned = String(input || '')
    .toUpperCase()
    .replace(/[\s=-]+/g, '');

  if (!cleaned) {
    throw new Error('TOTP secret is empty');
  }

  let bits = 0;
  let value = 0;
  const bytes = [];

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character in TOTP secret: "${ch}"`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  if (bytes.length === 0) {
    throw new Error('TOTP secret decoded to zero bytes');
  }

  return Buffer.from(bytes);
}

/**
 * Normalize a 2FA secret pasted as space-separated groups or otpauth:// URI.
 */
function normalizeTotpSecret(rawSecret) {
  const str = String(rawSecret || '').trim();
  if (!str) return '';
  if (str.toLowerCase().startsWith('otpauth://')) {
    try {
      const u = new URL(str);
      return u.searchParams.get('secret') || '';
    } catch {
      return str;
    }
  }
  return str.replace(/[\s-]+/g, '').toUpperCase();
}

/**
 * RFC 6238 TOTP generator (defaults match Google Authenticator: SHA1, 6 digits, 30s).
 */
function generateTOTP(secret, options = {}) {
  const normalized = normalizeTotpSecret(secret);
  const key = base32Decode(normalized);
  const stepSeconds = Number(options.stepSeconds || 30);
  const digits = Number(options.digits || 6);
  const algorithm = String(options.algorithm || 'sha1').toLowerCase();
  const timestampMs = options.timestampMs != null ? Number(options.timestampMs) : Date.now();

  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const counterBuf = Buffer.alloc(8);
  // Write 64-bit big-endian integer
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  counterBuf.writeUInt32BE(high, 0);
  counterBuf.writeUInt32BE(low, 4);

  const hmac = crypto.createHmac(algorithm, key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const mod = Math.pow(10, digits);
  return String(binary % mod).padStart(digits, '0');
}

function getTotpRemainingSeconds(stepSeconds = 30, timestampMs = Date.now()) {
  const elapsed = Math.floor(timestampMs / 1000) % stepSeconds;
  return stepSeconds - elapsed;
}

module.exports = {
  base32Decode,
  normalizeTotpSecret,
  generateTOTP,
  getTotpRemainingSeconds
};
