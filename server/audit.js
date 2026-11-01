// Append-only audit log of every device action and security event (JSON lines).
import fs from 'node:fs';
import path from 'node:path';

export class AuditLog {
  constructor(dir) { this.file = path.join(dir, 'audit.jsonl'); }
  write(event) {
    const entry = { at: new Date().toISOString(), ...event };
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    return entry;
  }
  tail(n = 50) {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => JSON.parse(l)).reverse();
  }
}
