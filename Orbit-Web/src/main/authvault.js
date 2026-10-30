'use strict';
// Password-protected store for authenticator (TOTP) secrets.
//
// File layout: safeStorage-encrypted JSON (tied to the OS account, as before) holding
//   { v: 2, salt, iv, tag, data }  where data = AES-256-GCM(scrypt(password, salt), JSON accounts)
// so the secrets need both this OS account and the authenticator password. Files from
// before v2 (a plain account list) are read once and re-encrypted when a password is set.
const crypto = require('node:crypto');
const fs = require('node:fs');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const IDLE_LOCK_MS = 5 * 60 * 1000;
const MIN_PASSWORD = 6;

class AuthVault {
  /**
   * @param file         path of authenticator.bin
   * @param safeStorage  Electron safeStorage (or a stand-in with the same API in tests)
   */
  constructor(file, safeStorage) {
    this.file = file;
    this.safe = safeStorage;
    this.key = null;        // derived key while unlocked
    this.salt = null;
    this.accounts = null;   // decrypted list while unlocked
    this.failures = 0;
    this.blockedUntil = 0;
    this.timer = null;
  }

  // ---- file ----
  readOuter() {
    let raw;
    try {
      raw = fs.readFileSync(this.file);
    } catch {
      return null;
    }
    const json = this.safe.isEncryptionAvailable() ? this.safe.decryptString(raw) : raw.toString('utf8');
    return JSON.parse(json);
  }

  writeOuter(obj) {
    const json = JSON.stringify(obj);
    const data = this.safe.isEncryptionAvailable() ? this.safe.encryptString(json) : Buffer.from(json);
    fs.writeFileSync(this.file, data, { mode: 0o600 });
  }

  // ---- state ----
  /** 'setup' (no password yet), 'locked' or 'open' */
  state() {
    if (this.key) return 'open';
    const outer = this.readOuter();
    return outer && outer.v === 2 ? 'locked' : 'setup';
  }

  setup(password) {
    if (this.state() !== 'setup') throw new Error('the authenticator already has a password');
    checkStrength(password);
    const legacy = this.readOuter();
    this.salt = crypto.randomBytes(16);
    this.key = derive(password, this.salt);
    this.accounts = Array.isArray(legacy) ? legacy : [];
    this.save();
    this.touch();
  }

  async unlock(password) {
    const wait = this.blockedUntil - Date.now();
    if (wait > 0) throw new Error(`too many wrong passwords: try again in ${Math.ceil(wait / 1000)} s`);
    const outer = this.readOuter();
    if (!outer || outer.v !== 2) throw new Error('set a password first');
    const salt = Buffer.from(outer.salt, 'base64');
    const key = derive(String(password || ''), salt);
    let accounts;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(outer.iv, 'base64'));
      d.setAuthTag(Buffer.from(outer.tag, 'base64'));
      accounts = JSON.parse(Buffer.concat([d.update(Buffer.from(outer.data, 'base64')), d.final()]).toString('utf8'));
    } catch {
      // back off after repeated misses: 3 free tries, then 5 s, 10 s, 20 s ... up to 5 min
      this.failures += 1;
      if (this.failures >= 3) this.blockedUntil = Date.now() + Math.min(300, 5 * 2 ** (this.failures - 3)) * 1000;
      throw new Error('wrong password');
    }
    this.failures = 0;
    this.salt = salt;
    this.key = key;
    this.accounts = accounts;
    this.touch();
  }

  changePassword(oldPassword, newPassword) {
    if (!this.key) throw new Error('unlock the authenticator first');
    checkStrength(newPassword);
    if (!crypto.timingSafeEqual(derive(String(oldPassword || ''), this.salt), this.key)) throw new Error('wrong password');
    this.salt = crypto.randomBytes(16);
    this.key = derive(newPassword, this.salt);
    this.save();
  }

  lock() {
    if (this.key) this.key.fill(0);
    this.key = null;
    this.accounts = null;
    clearTimeout(this.timer);
  }

  // ---- accounts (only while open) ----
  list() {
    this.need();
    this.touch();
    return this.accounts;
  }

  replace(accounts) {
    this.need();
    this.accounts = accounts;
    this.save();
    this.touch();
  }

  // ---- internals ----
  need() {
    if (!this.key) throw new Error('the authenticator is locked');
  }

  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.lock(), IDLE_LOCK_MS);
    this.timer.unref?.();
  }

  save() {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(this.accounts), 'utf8'), c.final()]);
    this.writeOuter({ v: 2, salt: this.salt.toString('base64'), iv: iv.toString('base64'),
                      tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
}

function derive(password, salt) {
  return crypto.scryptSync(String(password).normalize('NFC'), salt, 32, SCRYPT);
}

function checkStrength(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new Error(`use at least ${MIN_PASSWORD} characters`);
  }
}

module.exports = { AuthVault, IDLE_LOCK_MS };
