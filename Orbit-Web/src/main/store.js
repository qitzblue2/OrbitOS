'use strict';
// Small JSON stores in the user data folder, written atomically and debounced.
const fs = require('node:fs');
const path = require('node:path');

class JsonStore {
  constructor(dir, name, initial) {
    this.file = path.join(dir, `${name}.json`);
    this.timer = null;
    try {
      this.data = { ...structuredClone(initial), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      this.data = structuredClone(initial);
    }
  }

  save(delay = 400) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

// History: newest first, capped, deduplicated per URL (visit count kept).
class History {
  constructor(store, limit = 5000) {
    this.store = store;
    this.limit = limit;
    if (!Array.isArray(store.data.items)) store.data.items = [];
  }

  add(url, title) {
    if (!/^https?:/.test(url)) return;
    const items = this.store.data.items;
    const i = items.findIndex((x) => x.url === url);
    const prev = i >= 0 ? items.splice(i, 1)[0] : null;
    items.unshift({ url, title: title || prev?.title || url, time: Date.now(), visits: (prev?.visits || 0) + 1 });
    if (items.length > this.limit) items.length = this.limit;
    this.store.save();
  }

  setTitle(url, title) {
    const it = this.store.data.items.find((x) => x.url === url);
    if (it && title) {
      it.title = title;
      this.store.save();
    }
  }

  search(q, limit = 200) {
    const s = (q || '').toLowerCase().trim();
    const items = this.store.data.items;
    return (s ? items.filter((x) => x.url.toLowerCase().includes(s) || x.title.toLowerCase().includes(s)) : items).slice(0, limit);
  }

  remove(url) {
    this.store.data.items = this.store.data.items.filter((x) => x.url !== url);
    this.store.save();
  }

  clear() {
    this.store.data.items = [];
    this.store.save();
  }

  topSites(n = 8) {
    // frecency: visits weighted by recency (a week halves the score)
    const now = Date.now();
    const byHost = new Map();
    for (const it of this.store.data.items) {
      let host;
      try {
        host = new URL(it.url).hostname.replace(/^www\./, '');
      } catch {
        continue;
      }
      const score = it.visits * Math.pow(0.5, (now - it.time) / (7 * 86400e3));
      const cur = byHost.get(host);
      if (!cur || cur.score < score) byHost.set(host, { host, url: `https://${new URL(it.url).host}/`, title: it.title, score: (cur?.score || 0) + score });
      else cur.score += score;
    }
    return [...byHost.values()].sort((a, b) => b.score - a.score).slice(0, n);
  }
}

module.exports = { JsonStore, History };
