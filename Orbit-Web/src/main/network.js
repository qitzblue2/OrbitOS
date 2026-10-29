'use strict';
// The request pipeline for a browser session (one per profile: normal, and each private window).
//
// Electron allows ONE listener per webRequest event per session, so everything that
// inspects requests lives here: HTTPS-only upgrades, the tracker shield, the ad blocker,
// third-party cookie blocking and privacy headers. Counts are kept per tab (webContents).
const fs = require('node:fs');
const path = require('node:path');
const { FiltersEngine, Request } = require('@ghostery/adblocker');
const { getDomain } = require('tldts');

const LIST_KEYS = ['ads', 'trackers', 'annoyances', 'social'];

class Engines {
  constructor(listDir, cacheDir) {
    this.listDir = listDir;
    this.cacheDir = cacheDir;
    this.engines = {};
    this.manifest = {};
  }

  load() {
    try {
      this.manifest = JSON.parse(fs.readFileSync(path.join(this.listDir, 'manifest.json'), 'utf8'));
    } catch {
      this.manifest = {};
    }
    for (const key of LIST_KEYS) this.engines[key] = this._loadOne(key);
  }

  _loadOne(key) {
    // updated lists (from Settings) live in the cache dir; shipped ones in the app
    for (const dir of [this.cacheDir, this.listDir]) {
      const bin = path.join(dir, `${key}.bin`);
      const txt = path.join(dir, `${key}.txt`);
      try {
        if (fs.existsSync(bin)) return FiltersEngine.deserialize(new Uint8Array(fs.readFileSync(bin)));
      } catch {
        /* engine format changed: rebuild from text */
      }
      if (fs.existsSync(txt)) {
        const engine = FiltersEngine.parse(fs.readFileSync(txt, 'utf8'), { loadCosmeticFilters: key !== 'trackers' });
        try {
          fs.mkdirSync(this.cacheDir, { recursive: true });
          fs.writeFileSync(path.join(this.cacheDir, `${key}.bin`), engine.serialize());
        } catch {
          /* read-only cache: fine, parse again next time */
        }
        return engine;
      }
    }
    return null;
  }

  async update(fetchImpl, onProgress = () => {}) {
    const { LISTS } = await import('../../tools/fetch-lists-data.mjs');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    let done = 0;
    for (const [key, [, url]] of Object.entries(LISTS)) {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const text = await res.text();
      const engine = FiltersEngine.parse(text, { loadCosmeticFilters: key !== 'trackers' });
      fs.writeFileSync(path.join(this.cacheDir, `${key}.bin`), engine.serialize());
      this.engines[key] = engine;
      this.manifest[key] = { ...(this.manifest[key] || {}), fetched: new Date().toISOString(),
                             rules: text.split('\n').filter((l) => l && !l.startsWith('!')).length };
      onProgress(++done / Object.keys(LISTS).length);
    }
    fs.writeFileSync(path.join(this.cacheDir, 'manifest.json'), JSON.stringify(this.manifest));
  }
}

function siteOf(url) {
  try {
    const u = new URL(url);
    return getDomain(u.hostname) || u.hostname;
  } catch {
    return '';
  }
}

const RESOURCE = { mainFrame: 'main_frame', subFrame: 'sub_frame', stylesheet: 'stylesheet', script: 'script',
                   image: 'image', font: 'font', object: 'object', xhr: 'xmlhttprequest', ping: 'ping',
                   cspReport: 'csp_report', media: 'media', webSocket: 'websocket', other: 'other' };

class Pipeline {
  /**
   * @param ses       Electron session
   * @param engines   shared Engines
   * @param ctx       { settings(), sitePrefs, tabOf(webContentsId) -> tab|null, onBlocked(tab, kind) }
   */
  constructor(ses, engines, ctx) {
    this.ses = ses;
    this.engines = engines;
    this.ctx = ctx;
    this.httpAllowed = new Set();   // hosts the user chose to visit over plain http this session
    this.install();
  }

  topUrlFor(details) {
    const tab = details.webContentsId ? this.ctx.tabOf(details.webContentsId) : null;
    return { tab, top: tab?.url || details.referrer || '' };
  }

  install() {
    const filter = { urls: ['<all_urls>'] };
    this.ses.webRequest.onBeforeRequest(filter, (details, cb) => cb(this.before(details)));
    this.ses.webRequest.onBeforeSendHeaders(filter, (details, cb) => cb(this.sendHeaders(details)));
    this.ses.webRequest.onHeadersReceived(filter, (details, cb) => cb(this.received(details)));
  }

  before(details) {
    const s = this.ctx.settings();
    const url = details.url;
    if (!/^(https?|wss?):/.test(url)) return {};
    const { tab, top } = this.topUrlFor(details);

    // HTTPS-only: upgrade plain http navigations and subresources (not localhost / private IPs)
    if (s.https && url.startsWith('http:')) {
      const u = new URL(url);
      const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(u.hostname) ||
                    u.hostname.endsWith('.local');
      if (!local && !this.httpAllowed.has(u.hostname)) {
        u.protocol = 'https:';
        if (u.port === '80') u.port = '';
        return { redirectURL: u.href };
      }
    }

    if (details.resourceType === 'mainFrame') {
      tab?.resetCounts();
      return {};
    }

    const site = siteOf(top);
    const prefs = this.ctx.sitePrefs(site);
    const req = Request.fromRawDetails({ url, sourceUrl: top || url, type: RESOURCE[details.resourceType] || 'other' });
    const E = this.engines.engines;

    if (s.shield && prefs.shield !== false && E.trackers) {
      const m = E.trackers.match(req);
      if (m.match && !m.exception) {
        this.ctx.onBlocked(tab, 'trackers', url);
        return m.redirect ? { redirectURL: m.redirect.dataUrl } : { cancel: true };
      }
    }
    if (s.ads && prefs.ads !== false) {
      for (const [key, on] of [['ads', s.easy], ['annoyances', s.annoy], ['social', s.social]]) {
        if (!on || !E[key]) continue;
        const m = E[key].match(req);
        if (m.match && !m.exception) {
          this.ctx.onBlocked(tab, 'ads', url);
          return m.redirect ? { redirectURL: m.redirect.dataUrl } : { cancel: true };
        }
      }
    }
    return {};
  }

  isThirdParty(details, top) {
    if (!top || details.resourceType === 'mainFrame') return false;
    const a = siteOf(details.url);
    const b = siteOf(top);
    return Boolean(a && b && a !== b);
  }

  sendHeaders(details) {
    const s = this.ctx.settings();
    const h = details.requestHeaders;
    if (s.dnt) {
      h.DNT = '1';
      h['Sec-GPC'] = '1';
    }
    h['Accept-Language'] = acceptLanguage(s.lang);
    const { top } = this.topUrlFor(details);
    if (s.cookies && this.isThirdParty(details, top)) {
      delete h.Cookie;
      delete h.cookie;
    }
    return { requestHeaders: h };
  }

  received(details) {
    const s = this.ctx.settings();
    if (!s.cookies || !details.responseHeaders) return {};
    const { top } = this.topUrlFor(details);
    if (!this.isThirdParty(details, top)) return {};
    const out = {};
    for (const [k, v] of Object.entries(details.responseHeaders)) {
      if (k.toLowerCase() !== 'set-cookie') out[k] = v;
    }
    return { responseHeaders: out };
  }

  cosmeticCss(url) {
    const s = this.ctx.settings();
    if (!s.ads) return '';
    let u;
    try {
      u = new URL(url);
    } catch {
      return '';
    }
    const site = siteOf(url);
    if (this.ctx.sitePrefs(site).ads === false) return '';
    const parts = [];
    for (const [key, on] of [['ads', s.easy], ['annoyances', s.annoy], ['social', s.social]]) {
      const e = this.engines.engines[key];
      if (!on || !e) continue;
      const { styles } = e.getCosmeticsFilters({ url, hostname: u.hostname, domain: site, getBaseRules: true,
                                                 getInjectionRules: false, getExtendedRules: false,
                                                 getRulesFromHostname: true, getRulesFromDOM: false });
      if (styles) parts.push(styles);
    }
    return parts.join('\n');
  }
}

function acceptLanguage(lang) {
  const base = lang.split('-')[0];
  return [...new Set([lang, base, 'en-US', 'en'])].map((l, i) => (i ? `${l};q=${(1 - i * 0.1).toFixed(1)}` : l)).join(',');
}

module.exports = { Engines, Pipeline, siteOf, acceptLanguage, LIST_KEYS };
