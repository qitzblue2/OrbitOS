// Routines: named lists of spoken-style steps, run through the same engine (so permissions still apply).
import crypto from 'node:crypto';
import { JsonStore } from './store.js';

const DEFAULTS = [
  { name: 'movie', label: 'Movie mode', steps: ['set the living room lights to 20 percent', 'set volume to 60', 'open netflix'] },
  { name: 'gaming', label: 'Gaming setup', steps: ['open steam', 'open discord', 'set volume to 70', 'set the office lights to 40 percent'] },
  { name: 'development', label: 'Development environment', steps: ['open visual studio code', 'open terminal', 'open chrome'] },
  { name: 'focus', label: 'Focus', steps: ['pause music', 'set the office lights to 100 percent'] },
  { name: 'goodnight', label: 'Good night', steps: ['turn off all the lights', 'lock my computer'] },
];

export class Automations {
  constructor(dir) {
    this.store = new JsonStore(dir, 'automations', { routines: DEFAULTS.map((r) => ({ id: crypto.randomUUID(), ...r })), reminders: [] });
  }
  routines() { return this.store.data.routines; }
  find(name) {
    const n = name.toLowerCase().replace(/^(my|the)\s+/, '');
    return this.routines().find((r) => r.name === n || r.label.toLowerCase().startsWith(n) || n.includes(r.name));
  }
  upsert({ id, name, label, steps }) {
    const r = id && this.routines().find((x) => x.id === id);
    const clean = { name: String(name).toLowerCase().trim(), label: String(label || name).trim(), steps: (steps || []).map(String).filter(Boolean) };
    if (r) Object.assign(r, clean); else this.routines().push({ id: crypto.randomUUID(), ...clean });
    this.store.save();
    return r || this.routines().at(-1);
  }
  remove(id) { this.store.data.routines = this.routines().filter((r) => r.id !== id); this.store.save(); }
  reminders() { return this.store.data.reminders; }
  addReminder({ text, at }) {
    const r = { id: crypto.randomUUID(), text, at: new Date(at).toISOString(), done: false };
    this.store.data.reminders.push(r); this.store.save(); return r;
  }
  completeReminder(id) { const r = this.reminders().find((x) => x.id === id); if (r) { r.done = true; this.store.save(); } return r; }
  due(now = Date.now()) { return this.reminders().filter((r) => !r.done && !r.fired && new Date(r.at).getTime() <= now); }
}
