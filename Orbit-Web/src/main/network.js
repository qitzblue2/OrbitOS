'use strict';
const platform = require('./platform');
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
    this.matchCache = new WeakMap();   // engine -> Map(request key -> answer); a new engine starts empty
    this.install();
  }

  topUrlFor(details) {
    const tab = details.webContentsId ? this.ctx.tabOf(details.webContentsId) : null;
    return { tab, top: tab?.url || details.referrer || '' };
  }

  install() {
    const filter = { urls: ['<all_urls>'] };
    this.ses.webRequest.onBeforeRequest(filter, (details, cb) => cb(this.before(details)));
    this.refresh();
  }

  // Every registered hook costs a round-trip into JS for every request, so the header
  // hooks exist only while a setting needs them; Accept-Language is set by Chromium itself.
  refresh() {
    const s = this.ctx.settings();
    const filter = { urls: ['<all_urls>'] };
    const wr = this.ses.webRequest;
    // the sign-in hosts always need the header rewrite; everything else only for DNT/cookies
    const headerFilter = s.dnt || s.cookies ? filter : { urls: [...SIGN_IN_HOSTS].map((h) => `https://${h}/*`) };
    wr.onBeforeSendHeaders(headerFilter, (d, cb) => cb(this.sendHeaders(d)));
    if (s.cookies) wr.onHeadersReceived(filter, (d, cb) => cb(this.received(d)));
    else wr.onHeadersReceived(null);
    this.ses.setUserAgent(this.ses.getUserAgent(), languageList(s.lang));
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
      // Orbit Focus is on and this is one of the sites to keep away: show the focus page instead
      const sites = platform.focusSites();
      if (sites.length && tab && platform.focusBlocks(new URL(url).hostname, sites)) {
        setImmediate(() => tab.showFocus(url));
        return { cancel: true };
      }
      tab?.resetCounts();
      return {};
    }

    const site = siteOf(top);
    const prefs = this.ctx.sitePrefs(site);
    const type = RESOURCE[details.resourceType] || 'other';
    let req = null;
    const E = this.engines.engines;
    // Every request of every page passes here, in the main process, so a busy page can starve
    // the toolbar. Pages repeat the same requests a lot: remember each list's answer per
    // (list, type, page site, url) instead of matching again.
    const match = (key) => {
      const engine = E[key];
      let cache = this.matchCache.get(engine);
      if (!cache) {
        cache = new Map();
        this.matchCache.set(engine, cache);
      }
      const ck = `${type}\n${site}\n${url}`;
      let m = cache.get(ck);
      if (m === undefined) {
        req ||= Request.fromRawDetails({ url, sourceUrl: top || url, type });
        const r = engine.match(req);
        m = { match: r.match && !r.exception, redirect: r.redirect ? r.redirect.dataUrl : null };
        if (cache.size >= 4000) cache.delete(cache.keys().next().value);
        cache.set(ck, m);
      }
      return m;
    };

    if (s.shield && prefs.shield !== false && E.trackers) {
      const m = match('trackers');
      if (m.match) {
        this.ctx.onBlocked(tab, 'trackers', url);
        return m.redirect ? { redirectURL: m.redirect } : { cancel: true };
      }
    }
    if (s.ads && prefs.ads !== false) {
      for (const [key, on] of [['ads', s.easy], ['annoyances', s.annoy], ['social', s.social]]) {
        if (!on || !E[key]) continue;
        const m = match(key);
        if (m.match) {
          this.ctx.onBlocked(tab, 'ads', url);
          return m.redirect ? { redirectURL: m.redirect } : { cancel: true };
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
    if (isGoogleSignIn(details.url)) {
      h['User-Agent'] = SIGN_IN_UA;
      for (const k of Object.keys(h)) if (/^sec-ch-ua/i.test(k)) delete h[k];
    }
    if (s.dnt) {
      h.DNT = '1';
      h['Sec-GPC'] = '1';
    }
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

// plain list for session.setUserAgent; Chromium adds the q= weights itself
function languageList(lang) {
  return [...new Set([lang, lang.split('-')[0], 'en-US', 'en'])].join(',');
}

function acceptLanguage(lang) {
  const base = lang.split('-')[0];
  return [...new Set([lang, base, 'en-US', 'en'])].map((l, i) => (i ? `${l};q=${(1 - i * 0.1).toFixed(1)}` : l)).join(',');
}

// ---- Google sign-in ----
// Google refuses sign-in from browsers it identifies as Electron ("This browser or app may
// not be secure"). On its sign-in host only, Aphelion presents itself as Firefox (whose
// requests carry no Sec-CH-UA client hints), in navigator.userAgent and in the headers.
const SIGN_IN_HOSTS = new Set(['accounts.google.com', 'accounts.youtube.com']);
const SIGN_IN_UA = {
  win32: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
}[process.platform] || 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

function isGoogleSignIn(url) {
  try {
    return SIGN_IN_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** switch a webContents' user agent while its main frame is on a sign-in host */
function signInUserAgent(wc) {
  let on = false;
  const check = (d) => {
    if (!d.isMainFrame) return;
    const want = isGoogleSignIn(d.url);
    if (want === on) return;
    on = want;
    wc.setUserAgent(want ? SIGN_IN_UA : wc.session.getUserAgent());
  };
  wc.on('did-start-navigation', check);
  wc.on('did-redirect-navigation', check);
}

module.exports = { Engines, Pipeline, siteOf, acceptLanguage, LIST_KEYS, SIGN_IN_UA, isGoogleSignIn, signInUserAgent };
