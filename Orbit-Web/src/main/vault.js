'use strict';
// KeePass vault: opens a .kdbx file (KeePass2 / KeePassXC, KDBX 3.1 and 4) directly.
// The master password is never stored. Unlocked passwords stay as kdbxweb ProtectedValues
// in memory until locked; the vault locks itself after 15 minutes idle.
const fs = require('node:fs');
const crypto = require('node:crypto');
const kdbxweb = require('kdbxweb');
const { argon2d, argon2id } = require('hash-wasm');

kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) => {
  const fn = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d;
  const hash = await fn({ password: new Uint8Array(password), salt: new Uint8Array(salt), parallelism,
                          iterations, memorySize: memory, hashLength: length, outputType: 'binary' });
  return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
});

const IDLE_LOCK_MS = 15 * 60 * 1000;
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%&*+-=?@_';

function generatePassword(length = 20) {
  // rejection sampling: every character equally likely
  const out = [];
  const max = 256 - (256 % CHARSET.length);
  while (out.length < length) {
    for (const b of crypto.randomBytes(length * 2)) {
      if (b < max && out.length < length) out.push(CHARSET[b % CHARSET.length]);
    }
  }
  return out.join('');
}

function hostMatches(entryUrl, host) {
  if (!entryUrl || !host) return false;
  let h;
  try {
    h = new URL(/^[a-z]+:\/\//i.test(entryUrl) ? entryUrl : `https://${entryUrl}`).hostname;
  } catch {
    return false;
  }
  h = h.replace(/^www\./, '');
  const t = host.replace(/^www\./, '');
  return t === h || t.endsWith(`.${h}`);
}

class Vault {
  constructor() {
    this.db = null;
    this.path = '';
    this.timer = null;
  }

  get locked() {
    return !this.db;
  }

  touch() {
    clearTimeout(this.timer);
    if (this.db) this.timer = setTimeout(() => this.lock(), IDLE_LOCK_MS);
  }

  async unlock(file, password, keyFile = null) {
    const data = fs.readFileSync(file);
    const creds = new kdbxweb.KdbxCredentials(kdbxweb.ProtectedValue.fromString(password),
                                              keyFile ? fs.readFileSync(keyFile) : null);
    try {
      this.db = await kdbxweb.Kdbx.load(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), creds);
    } catch (e) {
      if (e.code === kdbxweb.Consts.ErrorCodes.InvalidKey) throw new Error('Wrong master password (or key file)');
      throw new Error(`Can’t open this database: ${e.message}`);
    }
    this.path = file;
    this.touch();
  }

  lock() {
    clearTimeout(this.timer);
    this.db = null;
  }

  *entries() {
    if (!this.db) return;
    const recycle = this.db.meta.recycleBinUuid?.id;
    const walk = function* (group) {
      if (recycle && group.uuid.id === recycle) return;
      for (const e of group.entries) yield e;
      for (const g of group.groups) yield* walk(g);
    };
    for (const g of this.db.groups) yield* walk(g);
  }

  static text(v) {
    return v instanceof kdbxweb.ProtectedValue ? v.getText() : (v || '');
  }

  summary(e) {
    return { id: e.uuid.id, title: Vault.text(e.fields.get('Title')) || '(untitled)',
             user: Vault.text(e.fields.get('UserName')), url: Vault.text(e.fields.get('URL')) };
  }

  search(query, host) {
    this.touch();
    const q = (query || '').toLowerCase().trim();
    const all = [...this.entries()].map((e) => this.summary(e));
    if (q) return { label: 'Results', items: all.filter((x) => `${x.title} ${x.user} ${x.url}`.toLowerCase().includes(q)).slice(0, 30) };
    const m = all.filter((x) => hostMatches(x.url, host));
    return m.length ? { label: `Matches for ${host}`, items: m } : { label: 'All entries', items: all.slice(0, 30) };
  }

  secret(id) {
    this.touch();
    for (const e of this.entries()) {
      if (e.uuid.id === id) return { user: Vault.text(e.fields.get('UserName')), password: Vault.text(e.fields.get('Password')) };
    }
    throw new Error('entry not found');
  }

  async addLogin({ title, url, user, password }) {
    if (!this.db) throw new Error('vault is locked');
    const group = this.db.getDefaultGroup();
    const e = this.db.createEntry(group);
    e.fields.set('Title', title);
    e.fields.set('URL', url);
    e.fields.set('UserName', user);
    e.fields.set('Password', kdbxweb.ProtectedValue.fromString(password));
    e.times.update();
    const out = Buffer.from(await this.db.save());
    // keep the previous file as a backup and write atomically
    fs.copyFileSync(this.path, `${this.path}.aphelion-backup`);
    fs.writeFileSync(`${this.path}.tmp`, out);
    fs.renameSync(`${this.path}.tmp`, this.path);
    this.touch();
    return this.summary(e);
  }
}

module.exports = { Vault, generatePassword, hostMatches };
