// Device registry for ORBIT Companion agents: pairing, per-device credentials, permissions, revocation.
import crypto from 'node:crypto';
import { JsonStore } from './store.js';

// Every action a Companion can perform. `sensitive` actions always require spoken/clicked confirmation.
export const CAPABILITIES = {
  'app.open':        { label: 'Open apps',            sensitive: false },
  'app.close':       { label: 'Close apps',           sensitive: false },
  'volume.set':      { label: 'Change volume',        sensitive: false },
  'media.control':   { label: 'Control media',        sensitive: false },
  'browser.search':  { label: 'Open web searches',    sensitive: false },
  'screen.capture':  { label: 'Take screenshots',     sensitive: false, privacy: true },
  'system.lock':     { label: 'Lock the device',      sensitive: false },
  'system.status':   { label: 'Read device status',   sensitive: false },
  'notify.show':     { label: 'Show notifications',   sensitive: false },
  'files.list':      { label: 'List approved folders',sensitive: false },
  'workflow.run':    { label: 'Run approved workflows', sensitive: false },
  'message.send':    { label: 'Send messages',        sensitive: true },
  'system.shutdown': { label: 'Shut down / restart',  sensitive: true },
  'command.run':     { label: 'Run approved commands',sensitive: true },
};
export const DEFAULT_PERMISSIONS = ['app.open', 'app.close', 'volume.set', 'media.control', 'browser.search', 'system.status', 'notify.show'];

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

export class DeviceRegistry {
  constructor(dir) {
    this.store = new JsonStore(dir, 'devices', { devices: [], pairing: [] });
    this.sockets = new Map(); // deviceId -> ws
  }
  // A short-lived one-time code shown in the dashboard and typed into the Companion.
  createPairingCode() {
    const code = String(crypto.randomInt(100000, 999999));
    const expiresAt = Date.now() + 10 * 60 * 1000;
    this.store.data.pairing = this.store.data.pairing.filter((p) => p.expiresAt > Date.now());
    this.store.data.pairing.push({ codeHash: hash(code), expiresAt });
    this.store.save();
    return { code, expiresAt };
  }
  pair({ code, name, platform }) {
    const now = Date.now();
    const idx = this.store.data.pairing.findIndex((p) => p.codeHash === hash(String(code)) && p.expiresAt > now);
    if (idx < 0) return null;
    this.store.data.pairing.splice(idx, 1);
    const token = crypto.randomBytes(32).toString('base64url');
    const device = {
      id: crypto.randomUUID(),
      name: String(name || 'Device').slice(0, 60),
      platform: String(platform || 'unknown'),
      tokenHash: hash(token),
      permissions: [...DEFAULT_PERMISSIONS],
      createdAt: new Date().toISOString(),
      lastSeen: null,
      revoked: false,
    };
    this.store.data.devices.push(device);
    this.store.flush();
    return { device: this.public(device), token };
  }
  authenticate(token) {
    if (!token) return null;
    const h = hash(token);
    const d = this.store.data.devices.find((x) => !x.revoked && crypto.timingSafeEqual(Buffer.from(x.tokenHash), Buffer.from(h)));
    return d || null;
  }
  get(id) { return this.store.data.devices.find((d) => d.id === id); }
  list() { return this.store.data.devices.filter((d) => !d.revoked).map((d) => this.public(d)); }
  public(d) {
    return { id: d.id, name: d.name, platform: d.platform, permissions: d.permissions, createdAt: d.createdAt, lastSeen: d.lastSeen, online: this.sockets.has(d.id), status: d.status || null };
  }
  setPermissions(id, perms) {
    const d = this.get(id);
    if (!d) return null;
    d.permissions = perms.filter((p) => p in CAPABILITIES);
    this.store.save();
    return this.public(d);
  }
  revoke(id) {
    const d = this.get(id);
    if (!d) return false;
    d.revoked = true;
    d.tokenHash = hash(crypto.randomBytes(16).toString('hex')); // token is dead even if file is restored
    this.store.flush();
    const ws = this.sockets.get(id);
    if (ws) { ws.close(4001, 'revoked'); this.sockets.delete(id); }
    return true;
  }
  rename(id, name) { const d = this.get(id); if (d) { d.name = String(name).slice(0, 60); this.store.save(); } return d && this.public(d); }
  touch(id, status) { const d = this.get(id); if (d) { d.lastSeen = new Date().toISOString(); if (status) d.status = status; this.store.save(); } }
  // Pick a target by spoken name ("my laptop", "the PC") or fall back to the only/first online device.
  resolve(hint) {
    const online = this.store.data.devices.filter((d) => !d.revoked && this.sockets.has(d.id));
    if (hint) {
      const h = hint.toLowerCase();
      const byName = online.find((d) => h.includes(d.name.toLowerCase()) || d.name.toLowerCase().includes(h));
      if (byName) return byName;
      const plat = { pc: 'windows', windows: 'windows', mac: 'darwin', macbook: 'darwin', phone: 'android', android: 'android', iphone: 'ios', ipad: 'ios', linux: 'linux' };
      for (const [k, v] of Object.entries(plat)) if (h.includes(k)) { const d = online.find((x) => x.platform === v); if (d) return d; }
    }
    return online.find((d) => ['windows', 'darwin', 'linux'].includes(d.platform)) || online[0] || null;
  }
}
