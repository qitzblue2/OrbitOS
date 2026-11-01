// Tiny durable JSON store with atomic writes. Swap for SQLite/Postgres behind the same API.
import fs from 'node:fs';
import path from 'node:path';

export class JsonStore {
  constructor(dir, name, initial) {
    this.file = path.join(dir, `${name}.json`);
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : structuredClone(initial);
    this._timer = null;
  }
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 50);
  }
  flush() {
    clearTimeout(this._timer);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
