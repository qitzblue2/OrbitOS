// Personal memory: permanent memories (persisted, user-editable) vs. session context (in RAM).
import crypto from 'node:crypto';
import { JsonStore } from './store.js';

export const MEMORY_KINDS = ['preference', 'person', 'project', 'routine', 'device', 'instruction', 'fact', 'task'];

// Things we refuse to store without explicit permission.
const SENSITIVE = [
  /\b\d{13,19}\b/,                       // card-like numbers
  /\b(password|passcode|pin|cvv|ssn|social security|iban|api[_ -]?key|secret)\b/i,
];
export const looksSensitive = (text) => SENSITIVE.some((r) => r.test(text));

const tokenize = (s) => s.toLowerCase().match(/[a-z0-9']{3,}/g) || [];

export class Memory {
  constructor(dir) {
    this.store = new JsonStore(dir, 'memory', { items: [] });
    this.sessions = new Map(); // sessionId -> [{role, content}]
  }
  list() { return this.store.data.items; }
  add({ text, kind = 'fact', source = 'user', allowSensitive = false }) {
    text = String(text || '').trim();
    if (!text) throw new Error('Memory text is empty');
    if (!MEMORY_KINDS.includes(kind)) kind = 'fact';
    if (looksSensitive(text) && !allowSensitive) {
      const e = new Error('This looks sensitive. Confirm to store it.');
      e.code = 'SENSITIVE';
      throw e;
    }
    const item = { id: crypto.randomUUID(), text, kind, source, createdAt: new Date().toISOString(), uses: 0 };
    this.store.data.items.push(item);
    this.store.save();
    return item;
  }
  update(id, patch) {
    const item = this.store.data.items.find((m) => m.id === id);
    if (!item) return null;
    if (patch.text !== undefined) item.text = String(patch.text).trim();
    if (patch.kind && MEMORY_KINDS.includes(patch.kind)) item.kind = patch.kind;
    item.updatedAt = new Date().toISOString();
    this.store.save();
    return item;
  }
  remove(id) {
    const before = this.store.data.items.length;
    this.store.data.items = this.store.data.items.filter((m) => m.id !== id);
    this.store.save();
    return this.store.data.items.length < before;
  }
  clear() { this.store.data.items = []; this.store.save(); }
  // Lightweight relevance: token overlap + recency. Replace with embeddings via the same signature.
  recall(query, limit = 6) {
    const q = new Set(tokenize(query));
    const scored = this.store.data.items.map((m) => {
      const t = tokenize(m.text);
      const overlap = t.filter((w) => q.has(w)).length;
      const always = m.kind === 'instruction' || m.kind === 'preference' ? 0.5 : 0;
      return { m, score: overlap + always };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
    for (const { m } of scored) m.uses++;
    if (scored.length) this.store.save();
    return scored.map((x) => x.m);
  }
  context(sessionId) {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
    return this.sessions.get(sessionId);
  }
  pushTurn(sessionId, role, content) {
    const ctx = this.context(sessionId);
    ctx.push({ role, content });
    while (ctx.length > 20) ctx.shift(); // temporary context is bounded and never persisted
  }
}
