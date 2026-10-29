'use strict';
// A browser window: frameless BaseWindow + the toolbar UI view on top + one view per tab.
const { BaseWindow, WebContentsView, screen } = require('electron');
const path = require('node:path');
const { Tab } = require('./tab');
const { toUrl, isSecure, hostOf, displayUrl } = require('./url');

const UI_PRELOAD = path.join(__dirname, '..', 'preload', 'ui.js');
const STRIP = { normal: 44, compact: 38 };
const TOOLBAR = 50;
const BAR = 40;   // find / translate / permission bar

class BrowserWindowController {
  constructor(app, { session, pipeline, isPrivate = false, restore = null, bounds = null }) {
    this.app = app;
    this.session = session;
    this.pipeline = pipeline;
    this.isPrivate = isPrivate;
    this.tabs = [];
    this.activeId = null;
    this.closed = [];          // recently closed tabs (Ctrl+Shift+T)
    this.overlay = null;       // popover/menu name while the UI covers the whole window
    this.find = null;          // { text, matches, active }
    this.bars = [];            // info bars: { id, kind, text, actions }
    this.addr = '';
    const wa = screen.getPrimaryDisplay().workAreaSize;
    this.win = new BaseWindow({
      width: bounds?.width || Math.min(1400, wa.width - 80), height: bounds?.height || Math.min(900, wa.height - 60),
      x: bounds?.x, y: bounds?.y, minWidth: 520, minHeight: 360, frame: false, show: false,
      backgroundColor: '#1a1a1d', title: isPrivate ? 'Aphelion (private)' : 'Aphelion',
      icon: path.join(__dirname, '..', '..', 'assets', 'icons', 'png', '512x512.png'),
    });
    this.ui = new WebContentsView({ webPreferences: { preload: UI_PRELOAD, sandbox: true, contextIsolation: true } });
    this.ui.setBackgroundColor('#00000000');
    this.win.contentView.addChildView(this.ui);
    this.ui.webContents.loadURL(`aphelion://ui/?private=${isPrivate ? 1 : 0}`);
    this.ui.webContents.on('before-input-event', (e, input) => this.shortcut(e, input));
    this.ui.webContents.once('did-finish-load', () => {
      this.changed();
      this.win.show();
    });
    this.win.on('resize', () => this.layout());
    this.win.on('maximize', () => this.changed());
    this.win.on('unmaximize', () => this.changed());
    this.win.on('enter-full-screen', () => this.changed());
    this.win.on('leave-full-screen', () => this.changed());
    this.win.on('focus', () => app.focused(this));
    this.win.on('closed', () => this.onClosed());

    if (restore?.tabs?.length) {
      for (const t of restore.tabs) this.tabs.push(new Tab(this, { url: t.url, session, background: true,
                                                                   restore: { ...t, sleeping: true } }));
      this.select(this.tabs[Math.min(restore.active || 0, this.tabs.length - 1)].id);
    } else {
      this.newTab(app.startPage());
    }
  }

  // ---------- views ----------
  chromeHeight() {
    const s = this.app.settings();
    return (s.compact ? STRIP.compact : STRIP.normal) + TOOLBAR + this.bars.length * BAR + (this.find ? BAR : 0);
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    const top = this.win.isFullScreen() && this.app.settings().immersive ? 0 : this.chromeHeight();
    const t = this.active();
    if (t?.view) t.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    // the UI view covers the whole window while a popover is open (transparent elsewhere)
    this.ui.setBounds({ x: 0, y: 0, width, height: this.overlay ? height : top });
  }

  attach(tab) {
    if (tab.id === this.activeId && tab.view) {
      for (const t of this.tabs) if (t !== tab && t.view) this.win.contentView.removeChildView(t.view);
      this.win.contentView.addChildView(tab.view, 0);
      this.layout();
    }
  }

  detach(tab) {
    if (tab.view) this.win.contentView.removeChildView(tab.view);
  }

  // ---------- tabs ----------
  active() {
    return this.tabs.find((t) => t.id === this.activeId) || null;
  }

  newTab(url, { background = false, opener = null, restore = null } = {}) {
    const target = toUrl(url || this.app.startPage(), this.app.settings().engine) || this.app.startPage();
    const tab = new Tab(this, { url: target, session: this.session, background, restore });
    const at = opener ? this.tabs.indexOf(opener) + 1 : this.tabs.length;
    this.tabs.splice(at, 0, tab);
    if (!background) this.select(tab.id);
    else this.changed();
    if (!background && target.startsWith('aphelion://newtab')) this.focusAddress();
    this.persist();
    return tab;
  }

  select(id) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.activeId = id;
    tab.lastActive = Date.now();
    this.addr = '';
    this.closePopover();
    this.stopFind();
    if (tab.sleeping) tab.wake();
    else this.attach(tab);
    this.layout();
    tab.wc?.focus();
    this.changed();
    this.persist();
  }

  close(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    if (!this.isPrivate) this.closed.push(tab.serialize());
    if (this.closed.length > 25) this.closed.shift();
    tab.destroy();
    if (!this.tabs.length) {
      if (this.app.settings().closeLast === 'window') return this.win.close();
      this.newTab(this.app.startPage());
      return;
    }
    if (this.activeId === id) this.select(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    else this.changed();
    this.persist();
  }

  reopenClosed() {
    const t = this.closed.pop();
    if (t) this.newTab(t.url, { restore: { ...t, sleeping: false } });
  }

  move(id, toIndex) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = this.tabs.splice(i, 1);
    this.tabs.splice(Math.max(0, Math.min(this.tabs.length, toIndex)), 0, t);
    this.changed();
    this.persist();
  }

  cycle(dir) {
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    this.select(this.tabs[(i + dir + this.tabs.length) % this.tabs.length].id);
  }

  navigate(input) {
    const url = toUrl(input, this.app.settings().engine);
    if (!url) return;
    const t = this.active();
    this.addr = '';
    this.closePopover();
    if (!t) return this.newTab(url);
    if (t.sleeping) t.wake({ url });
    else t.wc.loadURL(url).catch(() => {});
    t.wc?.focus();
  }

  sleepIdle(now = Date.now()) {
    const s = this.app.settings();
    const limit = s.memsave ? 10 * 60e3 : s.sleep ? 30 * 60e3 : 0;
    if (!limit) return;
    for (const t of this.tabs) {
      if (t.id !== this.activeId && !t.sleeping && !t.audible && now - t.lastActive > limit) t.sleep();
    }
  }

  // ---------- popovers, bars, find ----------
  openPopover(name) {
    this.overlay = name;
    this.layout();
    this.ui.webContents.focus();
    this.changed();
  }

  closePopover() {
    if (!this.overlay) return;
    this.overlay = null;
    this.layout();
    this.changed();
  }

  addBar(bar) {
    this.bars = this.bars.filter((b) => b.id !== bar.id);
    this.bars.push(bar);
    this.layout();
    this.changed();
  }

  removeBar(id) {
    this.bars = this.bars.filter((b) => b.id !== id);
    this.layout();
    this.changed();
  }

  startFind() {
    this.find = this.find || { text: '', matches: 0, active: 0 };
    this.layout();
    this.changed();
    this.ui.webContents.focus();
    this.ui.webContents.send('focus', 'find');
  }

  findText(text, opts = {}) {
    if (!this.find) return;
    this.find.text = text;
    const wc = this.active()?.wc;
    if (!wc) return;
    if (!text) {
      wc.stopFindInPage('clearSelection');
      this.find.matches = 0;
      this.find.active = 0;
      return this.changed();
    }
    wc.findInPage(text, { forward: opts.forward !== false, findNext: Boolean(opts.next), matchCase: false });
  }

  foundInPage(tab, r) {
    if (!this.find || tab.id !== this.activeId) return;
    this.find.matches = r.matches;
    this.find.active = r.activeMatchOrdinal;
    this.changed();
  }

  stopFind() {
    if (!this.find) return;
    this.active()?.wc?.stopFindInPage('keepSelection');
    this.find = null;
    this.layout();
    this.changed();
  }

  focusAddress() {
    this.ui.webContents.focus();
    this.ui.webContents.send('focus', 'address');
  }

  zoom(dir) {
    const wc = this.active()?.wc;
    if (!wc) return;
    const steps = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
    const cur = wc.getZoomFactor();
    let next;
    if (dir === 0) next = this.app.settings().zoom / 100;
    else {
      const i = steps.findIndex((z) => z >= cur - 0.001);
      next = steps[Math.max(0, Math.min(steps.length - 1, (i < 0 ? steps.length - 1 : i) + dir))];
    }
    wc.setZoomFactor(next);
    this.app.setSiteZoom(this.active().url, dir === 0 ? null : next);
    this.changed();
  }

  // ---------- keyboard ----------
  shortcut(e, input) {
    if (input.type !== 'keyDown') return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    const k = input.key.toLowerCase();
    const run = (fn) => {
      e.preventDefault();
      fn();
    };
    const t = this.active();
    if (mod && !input.shift && k === 't') return run(() => this.newTab());
    if (mod && input.shift && k === 't') return run(() => this.reopenClosed());
    if (mod && !input.shift && k === 'w') return run(() => this.close(this.activeId));
    if (mod && input.shift && k === 'n') return run(() => this.app.newWindow({ isPrivate: true }));
    if (mod && !input.shift && k === 'n') return run(() => this.app.newWindow({}));
    if ((mod && k === 'l') || (input.alt && k === 'd') || k === 'f6') return run(() => this.focusAddress());
    if ((mod && k === 'r') || k === 'f5') return run(() => (input.shift ? t?.wc?.reloadIgnoringCache() : t?.wc?.reload()));
    if (mod && k === 'f') return run(() => this.startFind());
    if (k === 'escape' && (this.find || this.overlay)) return run(() => (this.overlay ? this.closePopover() : this.stopFind()));
    if (mod && k === 'tab') return run(() => this.cycle(input.shift ? -1 : 1));
    if (mod && /^[1-9]$/.test(k)) return run(() => this.select((k === '9' ? this.tabs.at(-1) : this.tabs[Number(k) - 1])?.id));
    if ((input.alt && k === 'arrowleft') || (mod && k === '[')) return run(() => t?.wc?.navigationHistory.goBack());
    if ((input.alt && k === 'arrowright') || (mod && k === ']')) return run(() => t?.wc?.navigationHistory.goForward());
    if (mod && (k === '=' || k === '+')) return run(() => this.zoom(1));
    if (mod && k === '-') return run(() => this.zoom(-1));
    if (mod && k === '0') return run(() => this.zoom(0));
    if (mod && k === 'd') return run(() => this.app.toggleBookmark(this));
    if (mod && k === 'h') return run(() => this.newTab('aphelion://history/'));
    if (mod && input.shift && k === 'o') return run(() => this.newTab('aphelion://bookmarks/'));
    if (mod && k === 'j') return run(() => this.openPopover('dl'));
    if (mod && k === ',') return run(() => this.newTab('aphelion://settings/'));
    if (mod && k === 'p') return run(() => t?.wc?.print());
    if (mod && input.alt && k === 'r') return run(() => this.app.readerView(this));
    if (k === 'f11') return run(() => this.win.setFullScreen(!this.win.isFullScreen()));
    if (k === 'f12' || (mod && input.shift && k === 'i')) return run(() => t?.wc?.toggleDevTools());
  }

  // ---------- state ----------
  changed() {
    if (this._pending || this.win.isDestroyed()) return;
    this._pending = setTimeout(() => {
      this._pending = null;
      if (!this.win.isDestroyed()) this.ui.webContents.send('state', this.state());
    }, 16);
  }

  state() {
    const t = this.active();
    const s = this.app.settings();
    const wc = t?.wc;
    const url = t?.url || '';
    return {
      private: this.isPrivate,
      platform: process.platform,
      maximized: this.win.isMaximized(),
      fullscreen: this.win.isFullScreen(),
      tabs: this.tabs.map((x) => x.state(x.id === this.activeId)),
      active: this.activeId,
      nav: {
        url: displayUrl(url), internal: /^aphelion:/.test(url), secure: isSecure(url),
        canBack: Boolean(wc?.navigationHistory.canGoBack()), canForward: Boolean(wc?.navigationHistory.canGoForward()),
        loading: Boolean(t?.loading), bookmarked: this.app.isBookmarked(url),
        zoom: wc ? Math.round(wc.getZoomFactor() * 100) : 100, host: hostOf(url), reader: Boolean(t?.hasArticle && s.ext1),
      },
      counts: t?.counts || { trackers: 0, ads: 0 },
      shieldOnForSite: this.app.sitePrefs(this.app.siteOf(url)).shield !== false && s.shield,
      adsOnForSite: this.app.sitePrefs(this.app.siteOf(url)).ads !== false && s.ads,
      overlay: this.overlay,
      find: this.find,
      bars: this.bars,
      ui: this.app.uiSettings(),
      widgets: this.app.widgetBadges(this),
    };
  }

  persist() {
    if (this.isPrivate) return;
    this.app.persistSession();
  }

  serialize() {
    return { tabs: this.tabs.filter((t) => !/^aphelion:\/\/(error|reader)/.test(t.url)).map((t) => t.serialize()),
             active: Math.max(0, this.tabs.findIndex((t) => t.id === this.activeId)), bounds: this.win.getNormalBounds() };
  }

  onClosed() {
    for (const t of this.tabs) t.destroy();
    this.tabs = [];
    this.app.windowClosed(this);
  }
}

module.exports = { BrowserWindowController };
