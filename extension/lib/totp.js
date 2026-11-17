(function (g) {
  'use strict';

  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function base32Decode(input) {
    const cleaned = String(input || '').toUpperCase().replace(/[\s=-]+/g, '');
    if (!cleaned) throw new Error('TOTP secret is empty');
    let bits = 0;
    let value = 0;
    const out = [];
    for (let i = 0; i < cleaned.length; i++) {
      const idx = ALPHABET.indexOf(cleaned[i]);
      if (idx === -1) throw new Error('Invalid Base32 char: ' + cleaned[i]);
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        out.push((value >>> bits) & 0xff);
      }
    }
    return new Uint8Array(out);
  }

  function normalizeSecret(raw) {
    const str = String(raw || '').trim();
    if (!str) return '';
    if (str.toLowerCase().startsWith('otpauth://')) {
      try {
        return new URL(str).searchParams.get('secret') || '';
      } catch {
        return str;
      }
    }
    return str.replace(/[\s-]+/g, '').toUpperCase();
  }

  async function generateTOTP(secret, options = {}) {
    const keyBytes = base32Decode(normalizeSecret(secret));
    const step = Number(options.stepSeconds || 30);
    const digits = Number(options.digits || 6);
    const ts = options.timestampMs != null ? Number(options.timestampMs) : Date.now();
    const counter = Math.floor(ts / 1000 / step);

    const counterBuf = new ArrayBuffer(8);
    const view = new DataView(counterBuf);
    view.setUint32(0, Math.floor(counter / 0x100000000), false);
    view.setUint32(4, counter >>> 0, false);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: { name: 'SHA-1' } },
      false,
      ['sign']
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, counterBuf));
    const offset = sig[sig.length - 1] & 0x0f;
    const binary =
      ((sig[offset] & 0x7f) << 24) |
      ((sig[offset + 1] & 0xff) << 16) |
      ((sig[offset + 2] & 0xff) << 8) |
      (sig[offset + 3] & 0xff);

    return String(binary % Math.pow(10, digits)).padStart(digits, '0');
  }

  g.NewShooterTOTP = {
    base32Decode,
    normalizeSecret,
    generateTOTP
  };
})(typeof self !== 'undefined' ? self : this);
