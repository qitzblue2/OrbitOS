'use strict';
// Site icons (favicons) kept on disk as small data: URLs, keyed by host, so tabs and
// new-tab shortcuts show a real icon at once and offline. Fetched through the browsing
// session, so they follow the same proxy and privacy rules as the page that used them.
const { JsonStore } = require('./store');

const MAX_BYTES = 96 * 1024;
const MAX_HOSTS = 600;
const REFRESH_MS = 7 * 24 * 3600 * 1000;
const TYPES = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml', 'image/jpeg',
                       'image/webp', 'image/gif']);

class IconCache {
  constructor(dir) {
    this.store = new JsonStore(dir, 'icons', { items: {} });
    this.pending = new Set();
  }

  get(host) {
    const items = this.store.data.items;
    const bare = String(host || '').replace(/^www\./, '');
    return items[host]?.data || items[bare]?.data || items[`www.${bare}`]?.data || '';
  }

  /** remember the icon a page announced; no-op if it is fresh in the cache */
  async remember(host, iconUrl, ses) {
    if (!host || !/^https:\/\//.test(iconUrl) || this.pending.has(host)) return;
    const cur = this.store.data.items[host];
    if (cur && cur.src === iconUrl && Date.now() - cur.at < REFRESH_MS) return;
    this.pending.add(host);
    try {
      const res = await ses.fetch(iconUrl, { signal: AbortSignal.timeout(8000), credentials: 'omit' });
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!res.ok || !TYPES.has(type)) return;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) return;
      this.store.data.items[host] = { data: `data:${type};base64,${buf.toString('base64')}`, src: iconUrl, at: Date.now() };
      this.trim();
      this.store.save(2000);
    } catch {
      /* offline or blocked: keep the letter tile */
    } finally {
      this.pending.delete(host);
    }
  }

  trim() {
    const items = this.store.data.items;
    const hosts = Object.keys(items);
    if (hosts.length <= MAX_HOSTS) return;
    hosts.sort((a, b) => items[a].at - items[b].at);
    for (const h of hosts.slice(0, hosts.length - MAX_HOSTS)) delete items[h];
  }

  clear() {
    this.store.data.items = {};
    this.store.save();
  }
}

module.exports = { IconCache };
