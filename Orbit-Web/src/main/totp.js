'use strict';
// RFC 6238 TOTP / RFC 4226 HOTP codes and otpauth:// parsing. No network, no phone sync.
const crypto = require('node:crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('the secret must be Base32 (letters A–Z and digits 2–7)');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret, counter, digits = 6, algorithm = 'sha1') {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algorithm, secret).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

function totp(account, now = Date.now()) {
  const period = account.period || 30;
  const counter = Math.floor(now / 1000 / period);
  return {
    code: hotp(base32Decode(account.secret), counter, account.digits || 6, account.algorithm || 'sha1'),
    remaining: period - (Math.floor(now / 1000) % period),
    period,
  };
}

function parseOtpauth(uri) {
  const u = new URL(uri);
  if (u.protocol !== 'otpauth:' || u.host !== 'totp') throw new Error('only otpauth://totp/ links are supported');
  const label = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const [issuerFromLabel, accountName] = label.includes(':') ? label.split(/:(.*)/s) : ['', label];
  const p = u.searchParams;
  const secret = p.get('secret');
  base32Decode(secret); // validate
  const algorithm = (p.get('algorithm') || 'SHA1').toLowerCase();
  if (!['sha1', 'sha256', 'sha512'].includes(algorithm)) throw new Error(`unsupported algorithm ${algorithm}`);
  const digits = Number(p.get('digits') || 6);
  const period = Number(p.get('period') || 30);
  if (![6, 7, 8].includes(digits) || !(period >= 10 && period <= 120)) throw new Error('unsupported digits/period');
  return { name: p.get('issuer') || issuerFromLabel || accountName || 'Account', account: accountName.trim(),
           secret: secret.toUpperCase().replace(/\s/g, ''), algorithm, digits, period };
}

module.exports = { base32Decode, hotp, totp, parseOtpauth };
