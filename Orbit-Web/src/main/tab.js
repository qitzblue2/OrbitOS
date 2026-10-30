'use strict';
// One browser tab: a sandboxed WebContentsView plus the state the toolbar shows.
const { WebContentsView } = require('electron');
const path = require('node:path');
const { signInUserAgent } = require('./network');

let nextId = 1;
const PRELOAD = path.join(__dirname, '..', '..', 'dist-bundle', 'tab-preload.js');

class Tab {
  constructor(win, { url, session, background = false, restore = null }) {
    this.win = win;
    this.id = nextId++;
    this.session = session;
    this.url = url || 'aphelion://newtab/';
    this.title = restore?.title || '';
    this.favicon = '';
    this.loading = false;
    this.audible = false;
    this.playing = false;
    this.mediaTitle = '';
    this.sleeping = false;
    this.crashed = false;
    this.counts = { trackers: 0, ads: 0 };
    this.lastActive = background ? 0 : Date.now();
    this.pageLang = '';
    this.hasArticle = false;
    this.history = restore?.history || null;   // navigation entries kept while asleep / across restarts
    this.view = null;
    if (restore?.sleeping) {
      this.sleeping = true;
      this.url = restore.url;
    } else {
      this.wake(restore ? { url: restore.url, history: restore.history } : { url: this.url });
    }
  }

  get wc() {
    return this.view?.webContents || null;
  }

  wake(from = null) {
    if (this.view) return;
    const s = this.win.app.settings();
    this.view = new WebContentsView({
      webPreferences: {
        session: this.session,
        preload: PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        safeDialogs: true,
        spellcheck: s.spell,
        navigateOnDragDrop: false,
        autoplayPolicy: 'document-user-activation-required',
      },
    });
    // opaque, like a normal browser tab: a see-through page view makes the compositor
    // blend every frame with what is behind it (Aphelion's own pages paint their background)
    this.view.setBackgroundColor('#ffffff');
    const wc = this.view.webContents;
    if (s.webrtc) wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    this.bind(wc);
    this.sleeping = false;
    const hist = from?.history || this.history;
    if (hist?.entries?.length && wc.navigationHistory?.restore) {
      wc.navigationHistory.restore({ entries: hist.entries, index: hist.index }).catch(() => wc.loadURL(this.url));
    } else {
      wc.loadURL(from?.url || this.url).catch(() => {});
    }
    this.history = null;
    this.win.attach(this);
  }

  sleep() {
    if (!this.view || this.sleeping || this.audible) return;
    const wc = this.view.webContents;
    try {
      this.history = { entries: wc.navigationHistory.getAllEntries().slice(-50), index: Math.min(wc.navigationHistory.getActiveIndex(), 49) };
    } catch {
      this.history = null;
    }
    this.win.detach(this);
    wc.close();
    this.view = null;
    this.sleeping = true;
    this.loading = false;
    this.win.changed();
  }

  resetCounts() {
    this.counts = { trackers: 0, ads: 0 };
    this.win.changed();
  }

  bind(wc) {
    const app = this.win.app;
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (/^aphelion:/.test(url) && !/^aphelion:/.test(wc.getURL())) return { action: 'deny' };
      // real popups (window.open with a size) stay popups: "Sign in with Google/Microsoft/Apple"
      // and payment windows talk back to their opener, which a plain new tab would break
      if (disposition === 'new-window' && /^https:/.test(url)) {
        return { action: 'allow', outlivesOpener: false,
                 overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, title: 'Aphelion',
                                                 webPreferences: { sandbox: true, contextIsolation: true, session: this.session } } };
      }
      this.win.newTab(url, { background: disposition === 'background-tab', opener: this });
      return { action: 'deny' };
    });
    signInUserAgent(wc);
    wc.on('did-create-window', (child) => signInUserAgent(child.webContents));
    const guard = (e, url) => {
      // web pages may never open Aphelion's own pages (settings, history, ...)
      if (/^aphelion:/.test(url) && !/^aphelion:/.test(wc.getURL()) && wc.getURL()) e.preventDefault();
    };
    wc.on('will-navigate', guard);
    wc.on('will-frame-navigate', (e) => guard(e, e.url));
    wc.on('did-start-loading', () => {
      this.loading = true;
      this.win.changed();
    });
    wc.on('did-stop-loading', () => {
      this.loading = false;
      this.win.changed();
    });
    wc.on('did-navigate', (_e, url) => {
      this.url = url;
      this.crashed = false;
      this.hasArticle = false;
      this.favicon = '';
      // an unanswered translate offer belongs to the page it was made for
      if (this.id === this.win.activeId && this.win.bars.some((b) => b.id === 'translate')) this.win.removeBar('translate');
      if (!this.session.isPrivate) app.history.add(url, wc.getTitle());
      this.win.changed();
      this.win.persist();
    });
    wc.on('did-navigate-in-page', (_e, url, isMain) => {
      if (!isMain) return;
      this.url = url;
      if (!this.session.isPrivate) app.history.add(url, wc.getTitle());
      this.win.changed();
    });
    wc.on('page-title-updated', (_e, title) => {
      this.title = title;
      if (!this.session.isPrivate) app.history.setTitle(this.url, title);
      this.win.changed();
    });
    wc.on('page-favicon-updated', (_e, icons) => {
      this.favicon = icons.find((u) => /^(https?|data):/.test(u)) || '';
      this.win.changed();
    });
    wc.on('audio-state-changed', (e) => {
      this.audible = e.audible;
      this.win.changed();
    });
    wc.on('media-started-playing', () => {
      this.playing = true;
      this.win.changed();
    });
    wc.on('media-paused', () => {
      this.playing = false;
      this.win.changed();
    });
    wc.on('dom-ready', () => this.decorate());
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3 || /^aphelion:/.test(url)) return; // -3 = aborted (user navigated away)
      const q = new URLSearchParams({ code: String(code), desc, url });
      wc.loadURL(`aphelion://error/?${q}`).catch(() => {});
    });
    wc.on('render-process-gone', (_e, d) => {
      if (d.reason === 'clean-exit') return;
      this.crashed = true;
      this.loading = false;
      const q = new URLSearchParams({ code: 'crashed', desc: d.reason, url: this.url });
      setTimeout(() => this.wc?.loadURL(`aphelion://error/?${q}`).catch(() => {}), 50);
      this.win.changed();
    });
    wc.on('found-in-page', (_e, r) => this.win.foundInPage(this, r));
    wc.on('context-menu', (_e, params) => this.win.app.contextMenu(this, params));
    wc.on('before-input-event', (e, input) => this.win.shortcut(e, input));
    wc.on('zoom-changed', (_e, dir) => this.win.zoom(dir === 'in' ? 1 : -1));
    wc.on('focus', () => this.win.closePopover());
  }

  decorate() {
    const wc = this.wc;
    if (!wc || /^aphelion:/.test(this.url)) return;
    const app = this.win.app;
    const s = app.settings();
    const css = this.win.pipeline.cosmeticCss(this.url);
    if (css) wc.insertCSS(css, { cssOrigin: 'user' }).catch(() => {});
    const picked = app.pickedRules(this.url);
    if (picked) wc.insertCSS(picked, { cssOrigin: 'user' }).catch(() => {});
    wc.send('aph:page-options', { dark: s.ext2, caret: s.caret, capture: s.save, autofill: s.autofill && !app.vault.locked,
                                  contrast: s.contrast, motion: s.motion });
    const base = s.zoom / 100 * (s.bigtext ? 1.15 : 1);
    const site = app.siteZoom(this.url);
    wc.setZoomFactor(site || base);
  }

  state(active) {
    return {
      id: this.id, title: this.title || titleFor(this.url), url: this.url, favicon: this.favicon, loading: this.loading,
      audible: this.audible, playing: this.playing, sleeping: this.sleeping, crashed: this.crashed, active,
      internal: /^aphelion:/.test(this.url), private: Boolean(this.session.isPrivate),
    };
  }

  serialize() {
    let history = this.history;
    if (this.wc) {
      try {
        history = { entries: this.wc.navigationHistory.getAllEntries().slice(-20).map(({ url, title }) => ({ url, title })),
                    index: Math.min(this.wc.navigationHistory.getActiveIndex(), 19) };
      } catch {
        history = null;
      }
    }
    return { url: this.url, title: this.title, history };
  }

  destroy() {
    if (this.view) {
      this.win.detach(this);
      this.view.webContents.close();
      this.view = null;
    }
  }
}

function titleFor(url) {
  if (!url || url.startsWith('aphelion://newtab')) return 'New Tab';
  const m = url.match(/^aphelion:\/\/([a-z]+)/);
  if (m) return m[1][0].toUpperCase() + m[1].slice(1);
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

module.exports = { Tab, titleFor };
