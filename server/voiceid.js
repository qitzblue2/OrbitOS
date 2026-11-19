// Voice ID: ORBIT learns your voice from a few sentences and, once set up, refuses risky spoken
// commands (shutdown, running commands, sending messages, agent approvals) from a voice that isn't
// yours. Only a voice fingerprint (a list of numbers) is stored, never a recording.
import { JsonStore } from './store.js';

export const ENROLL_COUNT = 3;
const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / Math.sqrt(x * y || 1); };

export class VoiceId {
  constructor(dir) {
    this.store = new JsonStore(dir, 'voiceid', { prints: [], threshold: 0.5 });
    this.enrolling = new Map(); // sessionId -> collected prints
  }
  get enrolled() { return this.store.data.prints.length >= ENROLL_COUNT; }
  status() { return { enrolled: this.enrolled, samples: this.store.data.prints.length, threshold: this.store.data.threshold }; }
  reset() { this.store.data.prints = []; this.store.save(); }
  startEnroll(sessionId) { this.enrolling.set(sessionId, []); }
  isEnrolling(sessionId) { return this.enrolling.has(sessionId); }
  cancelEnroll(sessionId) { this.enrolling.delete(sessionId); }
  // Returns { done, left } or { error } when the sample had no usable fingerprint.
  addSample(sessionId, print) {
    const got = this.enrolling.get(sessionId);
    if (!got) return null;
    if (!print?.length) return { error: true, left: ENROLL_COUNT - got.length };
    got.push(print);
    if (got.length < ENROLL_COUNT) return { done: false, left: ENROLL_COUNT - got.length };
    this.store.data.prints = got; this.store.save(); this.enrolling.delete(sessionId);
    return { done: true, left: 0 };
  }
  score(print) {
    if (!print?.length || !this.enrolled) return null;
    return Math.max(...this.store.data.prints.map((p) => cos(p, print)));
  }
  // true = it's you, false = someone else, null = can't tell (not set up, or typed / no fingerprint).
  matches(print) { const s = this.score(print); return s == null ? null : s >= this.store.data.threshold; }
}
