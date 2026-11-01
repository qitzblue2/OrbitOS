// Unlimited API keys across providers. Keys are encrypted at rest (AES-256-GCM, with a secret kept
// in a separate owner-only file) and never leave the server; clients only ever see the last 4 characters.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JsonStore } from '../store.js';
import { PROVIDERS } from './catalog.js';

// Turns provider errors into one plain sentence.
export function friendly(err) {
  const s = err.status, m = String(err.message || err);
  if (s === 401 || s === 403) return 'The provider rejected this key. Check it was copied fully and is still active.';
  if (s === 429) return 'Rate limit or quota reached. ORBIT will retry this key in a minute and use your other keys meanwhile.';
  if (s === 404) return 'Model not found for this key. Pick another model under "Which AI answers".';
  if (s === 402) return 'This account is out of credit.';
  if (s >= 500) return 'The provider is having problems right now.';
  if (/ECONNREFUSED|fetch failed/i.test(m)) return 'Could not reach the provider. For Ollama, make sure it is running.';
  if (/timeout|aborted/i.test(m)) return 'The provider took too long to answer.';
  return m.slice(0, 160);
}

export class Keyring {
  constructor(dir) {
    const secretFile = path.join(dir, 'keyring.secret');
    if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    this.secret = Buffer.from(fs.readFileSync(secretFile, 'utf8').trim(), 'base64');
    this.store = new JsonStore(dir, 'keys', {
      keys: [],
      routes: { fast: { provider: 'anthropic', model: '' }, reasoning: { provider: 'anthropic', model: '' } },
      fallback: true,
    });
    this.cursor = {}; // round-robin position per provider
  }
  get data() { return this.store.data; }

  encrypt(text) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', this.secret, iv);
    const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
  }
  decrypt(blob) {
    const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', this.secret, iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  }
  fingerprint(key) { return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16); }

  public(k) {
    const p = PROVIDERS[k.provider] || {};
    return { id: k.id, provider: k.provider, providerLabel: p.label || k.provider, label: k.label, last4: k.last4, baseUrl: k.baseUrl || p.baseUrl || '',
      enabled: k.enabled, createdAt: k.createdAt, uses: k.uses || 0, failures: k.failures || 0, lastError: k.lastError || null,
      lastUsed: k.lastUsed || null, coolingDown: (k.cooldownUntil || 0) > Date.now() };
  }
  list() { return this.data.keys.map((k) => this.public(k)); }

  add({ provider, key = '', label = '', baseUrl = '' }) {
    const p = PROVIDERS[provider];
    if (!p) throw new Error(`Unknown provider: ${provider}`);
    key = String(key).trim();
    if (!key && !p.keyOptional) throw new Error(`${p.label} needs an API key.`);
    if (key && p.keyPattern && !p.keyPattern.test(key)) throw new Error(`That doesn't look like a ${p.label} key (expected ${p.keyHint}).`);
    if (p.needsBaseUrl && !/^https?:\/\/\S+$/.test(baseUrl)) throw new Error('Enter the base URL of the API, for example https://example.com/v1');
    const fp = key ? this.fingerprint(key) : null;
    if (fp && this.data.keys.some((k) => k.fp === fp)) throw new Error('That key is already saved.');
    const item = {
      id: crypto.randomUUID(), provider, label: String(label || `${p.label.replace(/ \(.*\)$/, '')} ${this.data.keys.filter((k) => k.provider === provider).length + 1}`).slice(0, 60),
      enc: key ? this.encrypt(key) : null, fp, last4: key ? key.slice(-4) : '', baseUrl: baseUrl || '', enabled: true, createdAt: new Date().toISOString(),
    };
    this.data.keys.push(item);
    // If the providers ORBIT is set to use have no working key, start using this one.
    for (const tier of ['fast', 'reasoning']) {
      const r = this.data.routes[tier];
      if (!this.data.keys.some((k) => k.enabled && k.provider === r.provider)) this.data.routes[tier] = { provider, model: '' };
    }
    this.store.flush();
    return this.public(item);
  }
  update(id, patch) {
    const k = this.data.keys.find((x) => x.id === id);
    if (!k) return null;
    if (patch.label !== undefined) k.label = String(patch.label).slice(0, 60);
    if (patch.enabled !== undefined) { k.enabled = !!patch.enabled; k.cooldownUntil = 0; }
    if (patch.baseUrl !== undefined) k.baseUrl = String(patch.baseUrl);
    this.store.save();
    return this.public(k);
  }
  remove(id) { const n = this.data.keys.length; this.data.keys = this.data.keys.filter((k) => k.id !== id); this.store.flush(); return this.data.keys.length < n; }
  setRoutes({ fast, reasoning, fallback }) {
    for (const [tier, r] of [['fast', fast], ['reasoning', reasoning]]) if (r) {
      if (!PROVIDERS[r.provider]) throw new Error(`Unknown provider: ${r.provider}`);
      this.data.routes[tier] = { provider: r.provider, model: String(r.model || '').trim() };
    }
    if (fallback !== undefined) this.data.fallback = !!fallback;
    this.store.save();
    return { routes: this.data.routes, fallback: this.data.fallback };
  }

  // Ordered attempts for one request: the chosen provider's keys first (round-robin, so load and
  // rate limits spread across every key), then, if fallback is on, every other provider's keys.
  candidates(tier, { needVision = false } = {}) {
    const route = this.data.routes[tier];
    const now = Date.now();
    const usable = (k) => k.enabled && (k.cooldownUntil || 0) <= now && (!needVision || PROVIDERS[k.provider]?.vision);
    const rotate = (provider) => {
      const ks = this.data.keys.filter((k) => k.provider === provider && usable(k));
      if (!ks.length) return [];
      const start = (this.cursor[provider] = ((this.cursor[provider] ?? -1) + 1) % ks.length);
      return [...ks.slice(start), ...ks.slice(0, start)];
    };
    const out = rotate(route.provider).map((k) => ({ key: k, model: route.model || PROVIDERS[k.provider].models[tier] }));
    if (this.data.fallback) {
      const others = [...new Set(this.data.keys.map((k) => k.provider))].filter((p) => p !== route.provider);
      for (const p of others) for (const k of rotate(p)) out.push({ key: k, model: PROVIDERS[p].models[tier] || PROVIDERS[p].models.fast });
    }
    return out;
  }
  secretOf(k) { return k.enc ? this.decrypt(k.enc) : ''; }
  markSuccess(k) { k.uses = (k.uses || 0) + 1; k.lastUsed = new Date().toISOString(); k.lastError = null; this.store.save(); }
  markFailure(k, err) {
    k.failures = (k.failures || 0) + 1;
    k.lastError = friendly(err);
    const s = err.status;
    // Bad key: park it for an hour. Rate limit: one minute. Outage or network: 15 seconds.
    k.cooldownUntil = Date.now() + (s === 401 || s === 403 ? 3600e3 : s === 429 ? 60e3 : 15e3);
    this.store.save();
  }
}
