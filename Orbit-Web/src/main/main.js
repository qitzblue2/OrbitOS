'use strict';
// Aphelion: main process. Owns settings, sessions, windows and every IPC handler.
const { app, protocol, session, ipcMain, Menu, clipboard, dialog, shell, net, nativeTheme, safeStorage,
        nativeImage, BaseWindow, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const schema = require('./schema');
const { JsonStore, History } = require('./store');
const { Engines, Pipeline, siteOf } = require('./network');
const { BrowserWindowController } = require('./window');
const { Vault, generatePassword } = require('./vault');
const totpLib = require('./totp');
const { AuthVault } = require('./authvault');
const { IconCache } = require('./icons');
const platform = require('./platform');
const { toUrl, hostOf } = require('./url');

const ROOT = path.join(__dirname, '..', '..');
const PAGES = path.join(ROOT, 'src', 'renderer', 'pages');
const INTERNAL = new Set(['newtab', 'settings', 'history', 'bookmarks', 'downloads', 'error', 'reader', 'about']);
// New-tab page layout, all user choices; validated field by field in setNewtab()
const NEWTAB_DEFAULTS = {
  source: 'auto',          // 'auto' = bookmarks + most visited, 'mine' = only the shortcuts the user added
  mine: [],                // [{ title, url }]
  hidden: [],              // hosts removed from the automatic list
  showBrand: true, showSearch: true, showTiles: true, showClock: true, labels: true,
  greeting: '',            // optional line under the clock
  shape: 'rounded',        // rounded | circle | square
  size: 'm',               // s | m | l
  columns: 6,              // 3..8
  rows: 2,                 // 1..4
  image: false,            // a background picture the user picked
  dim: 25,                 // 0..70 % darkening over the picture
  blur: 0,                 // 0..20 px
};
const UI_ONLY = 'ui';   // the toolbar page: served to the window UI only, never to a tab

protocol.registerSchemesAsPrivileged([{ scheme: 'aphelion', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (!app.requestSingleInstanceLock()) app.exit(0);

class Aphelion {
  constructor() {
    const dir = app.getPath('userData');
    this.store = new JsonStore(dir, 'settings', schema.defaults());
    this.bookmarks = new JsonStore(dir, 'bookmarks', { items: [] });
    this.historyStore = new JsonStore(dir, 'history', { items: [] });
    this.history = new History(this.historyStore);
    this.sites = new JsonStore(dir, 'sites', { prefs: {}, zoom: {}, picked: {}, perms: {} });
    this.sessionStore = new JsonStore(dir, 'session', { windows: [] });
    this.notesStore = new JsonStore(dir, 'notes-meta', { text: '' });
    this.icons = new IconCache(dir);
    this.newtab = new JsonStore(dir, 'newtab', NEWTAB_DEFAULTS);
    this.newtabImage = path.join(dir, 'newtab-background');
    this.windows = new Set();
    this.lastFocused = null;
    this.vault = new Vault();
    this.downloads = [];
    this.adsTotal = 0;
    this.pipelines = new Map();
    this.permPrompts = new Map();
    this.orbitStyle = null;
    this.engines = new Engines(path.join(ROOT, 'assets', 'lists'), path.join(dir, 'filter-lists'));
    this.auth = new AuthVault(path.join(dir, 'authenticator.bin'), safeStorage);
  }

  // ---------- settings ----------
  settings() {
    return this.store.data;
  }

  setNewtab(patch) {
    const n = this.newtab.data;
    const pick = (v, list) => (list.includes(v) ? v : undefined);
    const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
    const rules = {
      source: (v) => pick(v, ['auto', 'mine']), shape: (v) => pick(v, ['rounded', 'circle', 'square']),
      size: (v) => pick(v, ['s', 'm', 'l']), columns: (v) => int(v, 3, 8), rows: (v) => int(v, 1, 4),
      dim: (v) => int(v, 0, 70), blur: (v) => int(v, 0, 20),
      greeting: (v) => (typeof v === 'string' ? v.slice(0, 80) : undefined),
    };
    for (const k of ['showBrand', 'showSearch', 'showTiles', 'showClock', 'labels', 'image']) rules[k] = (v) => (typeof v === 'boolean' ? v : undefined);
    for (const [k, v] of Object.entries(patch || {})) {
      if (!rules[k]) throw new Error(`unknown new-tab option ${k}`);
      const ok = rules[k](v);
      if (ok === undefined) throw new Error(`bad value for ${k}`);
      n[k] = ok;
    }
    this.newtab.save();
  }

  setSetting(key, value) {
    this.store.data[key] = schema.validate(key, value);
    this.store.save();
    if (key === 'spell' || key === 'lang') this.applySpell();
    if (['dnt', 'cookies', 'lang'].includes(key)) for (const p of this.pipelines.values()) p.refresh();
    this.broadcast();
    for (const w of this.windows) {
      w.layout();
      for (const t of w.tabs) if (['ext2', 'caret', 'zoom', 'bigtext', 'easy', 'annoy', 'social', 'ads', 'contrast', 'motion'].includes(key)) t.decorate();
    }
    this.pageEvent('settings', this.publicSettings());
  }

  publicSettings() {
    return { ...this.settings(), effectiveStyle: this.effectiveStyle(), downloadDirEffective: platform.tilde(this.downloadDir()), vaultPath: this.settings().vaultPath,
             orbit: platform.isOrbit(), engines: Object.fromEntries(Object.entries(schema.ENGINES).map(([k, v]) => [k, v.name])),
             languages: schema.LANGUAGES, version: app.getVersion(), chrome: process.versions.chrome,
             electron: process.versions.electron, lists: this.engines.manifest, platform: process.platform };
  }

  effectiveStyle() {
    const s = this.settings().style;
    if (s !== 'auto') return s;
    return this.orbitStyle || (nativeTheme.shouldUseDarkColors ? 'Glass' : 'Light');
  }

  uiSettings() {
    const s = this.settings();
    return { style: this.effectiveStyle(), bg: s.bg, reduce: s.reduce, compact: s.compact, contrast: s.contrast,
             motion: s.motion || false, bigtext: s.bigtext };
  }

  startPage() {
    return this.settings().startup === 'blank' ? 'about:blank' : 'aphelion://newtab/';
  }

  downloadDir() {
    return this.settings().downloadDir || platform.downloadsDir(app);
  }

  applySpell() {
    const s = this.settings();
    for (const ses of this.allSessions()) {
      ses.setSpellCheckerEnabled(s.spell);
      if (process.platform !== 'darwin') {
        try {
          ses.setSpellCheckerLanguages([s.lang]);
        } catch {
          /* language not available on this OS: keep the default */
        }
      }
    }
  }

  // ---------- sites ----------
  siteOf(url) {
    return siteOf(url);
  }

  sitePrefs(site) {
    return this.sites.data.prefs[site] || {};
  }

  setSitePref(site, key, value) {
    if (!site) return;
    const p = { ...this.sitePrefs(site), [key]: value };
    this.sites.data.prefs[site] = p;
    this.sites.save();
  }

  siteZoom(url) {
    return this.sites.data.zoom[hostOf(url)] || null;
  }

  setSiteZoom(url, z) {
    const h = hostOf(url);
    if (!h) return;
    if (z) this.sites.data.zoom[h] = z;
    else delete this.sites.data.zoom[h];
    this.sites.save();
  }

  pickedRules(url) {
    const rules = this.sites.data.picked[hostOf(url)] || [];
    return rules.map((sel) => `${sel} { display: none !important; }`).join('\n');
  }

  // ---------- sessions ----------
  allSessions() {
    return [...this.pipelines.keys()];
  }

  setupSession(ses, isPrivate) {
    ses.isPrivate = isPrivate;
    ses.protocol.handle('aphelion', (req) => this.serveInternal(req, false));
    const pipeline = new Pipeline(ses, this.engines, {
      settings: () => this.settings(),
      sitePrefs: (site) => this.sitePrefs(site),
      tabOf: (id) => this.tabByWebContentsId(id),
      onBlocked: (tab, kind) => {
        if (!tab) return;
        tab.counts[kind] += 1;
        if (kind === 'ads') this.adsTotal += 1;
        tab.win.changed();
      },
    });
    this.pipelines.set(ses, pipeline);
    ses.on('will-download', (_e, item, wc) => this.onDownload(item, wc, isPrivate));
    ses.setPermissionRequestHandler((wc, permission, cb, details) => this.onPermission(wc, permission, cb, details));
    ses.setPermissionCheckHandler((wc, permission, origin) => this.permAllowed(origin, permission) === true);
    ses.setSpellCheckerEnabled(this.settings().spell);
    const ua = ses.getUserAgent().replace(/Electron\/\S+\s/, '').replace(/aphelion\/\S+\s/i, '');
    ses.setUserAgent(ua);  // look like plain Chromium: fewer "unsupported browser" pages, less fingerprint
    pipeline.refresh();     // re-applies the Accept-Language list on top of that user agent
    return pipeline;
  }

  async serveInternal(req, forUi) {
    const u = new URL(req.url);
    const page = u.hostname;
    if (!(INTERNAL.has(page) || (forUi && page === UI_ONLY))) return new Response('Not found', { status: 404 });
    if (page === 'newtab' && u.pathname === '/background') {
      try {
        const type = fs.readFileSync(`${this.newtabImage}.type`, 'utf8');
        return new Response(fs.readFileSync(this.newtabImage), { headers: { 'content-type': type, 'cache-control': 'no-store' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }
    const rel = u.pathname === '/' ? `${page}.html` : u.pathname.slice(1);
    const file = path.normalize(path.join(PAGES, rel));
    if (!file.startsWith(PAGES + path.sep)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; " +
      "connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
    return new Response(res.body, { status: res.status, headers });
  }

  tabByWebContentsId(id) {
    for (const w of this.windows) for (const t of w.tabs) if (t.wc && t.wc.id === id) return t;
    return null;
  }

  // ---------- windows ----------
  newWindow({ isPrivate = false, restore = null, url = null } = {}) {
    let ses;
    if (isPrivate) {
      ses = session.fromPartition(`private-${Date.now()}-${Math.random()}`, { cache: false });
      this.setupSession(ses, true);
    } else {
      ses = this.mainSession;
    }
    const w = new BrowserWindowController(this, { session: ses, pipeline: this.pipelines.get(ses), isPrivate,
                                                  restore, bounds: restore?.bounds });
    this.windows.add(w);
    this.lastFocused = w;
    if (url) w.newTab(url);
    return w;
  }

  focused(w) {
    this.lastFocused = w;
  }

  current() {
    return this.lastFocused && this.windows.has(this.lastFocused) ? this.lastFocused : [...this.windows][0];
  }

  windowClosed(w) {
    this.windows.delete(w);
    if (w.isPrivate) {
      w.session.clearStorageData().catch(() => {});
      this.pipelines.delete(w.session);
    }
    if (![...this.windows].some((x) => !x.isPrivate)) this.persistSession(true);
  }

  persistSession(keepLast = false) {
    if (!this.settings().restore) {
      this.sessionStore.data.windows = [];
    } else {
      const wins = [...this.windows].filter((w) => !w.isPrivate).map((w) => w.serialize());
      if (wins.length || !keepLast) this.sessionStore.data.windows = wins;
    }
    this.sessionStore.save(800);
  }

  broadcast() {
    for (const w of this.windows) w.changed();
  }

  pageEvent(name, payload) {
    for (const w of this.windows) for (const t of w.tabs) if (t.wc && /^aphelion:/.test(t.url)) t.wc.send('aph:event', name, payload);
  }

  widgetBadges(w) {
    const s = this.settings();
    const t = w.active();
    const site = t && !/^aphelion:/.test(t.url);
    const active = this.downloads.filter((d) => d.state === 'progressing').length;
    const playing = this.mediaTabs().some((x) => x.playing);
    return [
      s.wAds && { key: 'ads', icon: '⛉', badge: s.ads ? String(site ? t.counts.ads : 0) : 'off', title: 'Ad blocker' },
      s.wAuth && { key: 'auth', icon: '2FA', badge: '', title: 'Authenticator' },
      s.wNotes && { key: 'notes', icon: '✎', badge: '', title: 'Quick notes' },
      s.wDl && { key: 'dl', icon: '↓', badge: active ? String(active) : '', title: 'Downloads' },
      s.wMedia && { key: 'media', icon: '♫', badge: playing ? '▶' : '', title: 'Media controls' },
      s.wKp && { key: 'kp', icon: 'KP', badge: this.vault.locked ? '🔒︎' : '', title: 'KeePass' },
    ].filter(Boolean);
  }

  // ---------- bookmarks ----------
  isBookmarked(url) {
    return this.bookmarks.data.items.some((b) => b.url === url);
  }

  toggleBookmark(w) {
    const t = w.active();
    if (!t || /^aphelion:/.test(t.url)) return;
    const items = this.bookmarks.data.items;
    const i = items.findIndex((b) => b.url === t.url);
    if (i >= 0) items.splice(i, 1);
    else items.unshift({ url: t.url, title: t.title || t.url, time: Date.now() });
    this.bookmarks.save();
    this.broadcast();
    this.pageEvent('bookmarks', items);
  }

  // ---------- downloads ----------
  onDownload(item, wc, isPrivate) {
    const s = this.settings();
    const dir = this.downloadDir();
    fs.mkdirSync(dir, { recursive: true });
    if (!s.askdl) item.setSavePath(uniquePath(path.join(dir, item.getFilename())));
    const d = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: item.getFilename(), total: item.getTotalBytes(),
                received: 0, state: 'progressing', path: '', item, private: isPrivate, started: Date.now() };
    this.downloads.unshift(d);
    const update = () => {
      d.received = item.getReceivedBytes();
      d.total = item.getTotalBytes();
      d.path = item.getSavePath();
      d.name = path.basename(d.path || d.name);
      this.broadcast();
      this.uiEvent('downloads', this.downloadList());
    };
    item.on('updated', (_e, state) => {
      d.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
      update();
    });
    item.once('done', (_e, state) => {
      d.state = state;
      update();
    });
    const w = this.windowOf(wc) || this.current();
    if (w && s.wDl) w.openPopover('dl');
    update();
  }

  downloadList() {
    return this.downloads.slice(0, 30).map(({ item, ...d }) => ({ ...d, dir: platform.tilde(path.dirname(d.path || this.downloadDir())) }));
  }

  windowOf(wc) {
    for (const w of this.windows) if (w.tabs.some((t) => t.wc === wc) || w.ui.webContents === wc) return w;
    return null;
  }

  uiEvent(name, payload) {
    for (const w of this.windows) if (!w.ui.webContents.isDestroyed()) w.ui.webContents.send('event', name, payload);
  }

  // ---------- permissions ----------
  permAllowed(origin, permission) {
    const host = hostOf(origin);
    return this.sites.data.perms[host]?.[permission];
  }

  onPermission(wc, permission, cb, details) {
    const SAFE = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'window-management']);
    if (SAFE.has(permission)) return cb(true);
    const ASK = { media: details.mediaTypes?.includes('video') ? 'use your camera' : 'use your microphone',
                  geolocation: 'know your location', notifications: 'show notifications',
                  'clipboard-read': 'read your clipboard', midi: 'use MIDI devices', midiSysex: 'use MIDI devices',
                  'display-capture': 'see your screen', openExternal: 'open another app' };
    if (!ASK[permission]) return cb(false);
    const origin = details.requestingUrl || wc.getURL();
    const remembered = this.permAllowed(origin, permission);
    if (typeof remembered === 'boolean') return cb(remembered);
    const tab = this.tabByWebContentsId(wc.id);
    if (!tab) return cb(false);
    const id = `perm-${Date.now()}`;
    this.permPrompts.set(id, { cb, origin, permission });
    tab.win.addBar({ id, kind: 'permission', text: `${hostOf(origin)} wants to ${ASK[permission]}`,
                     actions: [['Allow', 'allow'], ['Block', 'block']], remember: true });
  }

  answerPermission(w, id, allow, remember) {
    const p = this.permPrompts.get(id);
    if (!p) return;
    this.permPrompts.delete(id);
    if (remember) {
      const host = hostOf(p.origin);
      this.sites.data.perms[host] = { ...(this.sites.data.perms[host] || {}), [p.permission]: allow };
      this.sites.save();
    }
    p.cb(Boolean(allow));
    w.removeBar(id);
  }

  // ---------- authenticator ----------
  readTotp() {
    return this.auth.list();
  }

  writeTotp(list) {
    this.auth.replace(list);
  }

  totpCodes() {
    const now = Date.now();
    return this.readTotp().map((a) => ({ id: a.id, name: a.name, account: a.account, ...totpLib.totp(a, now) }));
  }

  addTotp(input, name) {
    let acct;
    const s = String(input || '').trim();
    if (s.startsWith('otpauth://')) acct = totpLib.parseOtpauth(s);
    else {
      totpLib.base32Decode(s);
      acct = { name: name || 'Account', account: '', secret: s.toUpperCase().replace(/\s/g, ''), algorithm: 'sha1', digits: 6, period: 30 };
    }
    if (name) acct.name = name;
    acct.id = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const list = this.readTotp();
    list.push(acct);
    this.writeTotp(list);
    return acct.id;
  }

  // ---------- clipboard helpers ----------
  copySecret(text) {
    clipboard.writeText(text);
    clearTimeout(this._clipTimer);
    this._clipTimer = setTimeout(() => {
      if (clipboard.readText() === text) clipboard.clear();   // only if nobody copied something else since
    }, 30e3);
  }

  // ---------- notes ----------
  notesInfo() {
    const nf = platform.notesFile(app);
    let text = '';
    try {
      text = fs.readFileSync(nf.file, 'utf8');
    } catch {
      text = '';
    }
    return { text, label: nf.label };
  }

  saveNotes(text) {
    const nf = platform.notesFile(app);
    fs.mkdirSync(nf.dir, { recursive: true });
    fs.writeFileSync(`${nf.file}.tmp`, text);
    fs.renameSync(`${nf.file}.tmp`, nf.file);
  }

  // ---------- media ----------
  mediaTabs() {
    const out = [];
    for (const w of this.windows) for (const t of w.tabs) if (t.wc && (t.audible || t.playing)) out.push(t);
    return out;
  }

  // ---------- reader ----------
  async readerView(w) {
    const t = w.active();
    if (!t?.wc || /^aphelion:/.test(t.url)) return;
    const res = await this.askTab(t, 'reader');   // the tab preload runs Readability on the live page
    if (!res?.content) {
      w.addBar({ id: 'reader', kind: 'info', text: 'Reader view isn’t available for this page.', actions: [['OK', 'dismiss']] });
      return;
    }
    this.readerCache = { ...res, url: t.url };
    t.wc.loadURL('aphelion://reader/').catch(() => {});
  }

  askTab(t, what) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const done = (e, rid, data) => {
        if (rid !== id || e.sender !== t.wc) return;   // only the tab we asked may answer
        ipcMain.removeListener('aph:tab-reply', done);
        resolve(data);
      };
      ipcMain.on('aph:tab-reply', done);
      t.wc.send('aph:ask', id, what);
      setTimeout(() => {
        ipcMain.removeListener('aph:tab-reply', done);
        resolve(null);
      }, 4000);
    });
  }

  // ---------- context menu ----------
  contextMenu(tab, p) {
    const w = tab.win;
    const items = [];
    if (p.linkURL) {
      items.push({ label: 'Open Link in New Tab', click: () => w.newTab(p.linkURL, { background: true, opener: tab }) },
                 { label: 'Open Link in Private Window', click: () => this.newWindow({ isPrivate: true, url: p.linkURL }) },
                 { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push({ label: 'Open Image in New Tab', click: () => w.newTab(p.srcURL, { background: true, opener: tab }) },
                 { label: 'Save Image As…', click: () => tab.wc.downloadURL(p.srcURL) },
                 { label: 'Copy Image', click: () => tab.wc.copyImageAt(p.x, p.y) }, { type: 'separator' });
    }
    if (p.isEditable) {
      if (p.misspelledWord) {
        for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => tab.wc.replaceMisspelling(s) });
        items.push({ label: 'Add to Dictionary', click: () => tab.session.addWordToSpellCheckerDictionary(p.misspelledWord) },
                   { type: 'separator' });
      }
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
                 { role: 'selectAll' });
    } else if (p.selectionText) {
      const sel = p.selectionText.trim().slice(0, 200);
      items.push({ role: 'copy' }, { label: `Search for “${sel.length > 30 ? `${sel.slice(0, 30)}…` : sel}”`,
                                     click: () => w.newTab(toUrl(sel, this.settings().engine), { opener: tab }) });
    } else {
      items.push({ label: 'Back', enabled: tab.wc.navigationHistory.canGoBack(), click: () => tab.wc.navigationHistory.goBack() },
                 { label: 'Forward', enabled: tab.wc.navigationHistory.canGoForward(), click: () => tab.wc.navigationHistory.goForward() },
                 { label: 'Reload', click: () => tab.wc.reload() }, { type: 'separator' },
                 { label: 'Reader View', enabled: this.settings().ext1, click: () => this.readerView(w) },
                 { label: 'Hide an Element on This Page…', click: () => tab.wc.send('aph:picker') },
                 { label: 'Save Page As…', click: () => this.savePage(tab) }, { label: 'Print…', click: () => tab.wc.print() });
    }
    items.push({ type: 'separator' }, { label: 'Inspect', click: () => tab.wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup();
  }

  async savePage(tab) {
    const r = await dialog.showSaveDialog({ defaultPath: path.join(this.downloadDir(), `${(tab.title || 'page').replace(/[/\\?%*:|"<>]/g, '-')}.html`) });
    if (!r.canceled && r.filePath) tab.wc.savePage(r.filePath, 'HTMLComplete').catch(() => {});
  }

  // ---------- data ----------
  async clearData(what) {
    for (const ses of this.allSessions()) {
      if (what === 'history' || what === 'all') {
        this.history.clear();
        this.icons.clear();
      }
      if (what === 'cookies' || what === 'all') {
        await ses.clearStorageData();
        await ses.clearCache();
      }
    }
    if (what === 'all') this.downloads = this.downloads.filter((d) => d.state === 'progressing');
    this.pageEvent('history', []);
  }

  async checkUpdates() {
    try {
      const res = await net.fetch('https://api.github.com/repos/qitzblue2/OrbitOS/releases?per_page=20');
      if (!res.ok) throw new Error(`GitHub said ${res.status}`);
      const rel = (await res.json()).find((r) => /^aphelion-v/.test(r.tag_name));
      if (!rel) return { status: 'none', text: 'No Aphelion release published yet.' };
      const latest = rel.tag_name.replace('aphelion-v', '');
      const newer = latest.localeCompare(app.getVersion(), undefined, { numeric: true }) > 0;
      return { status: newer ? 'available' : 'current', text: newer ? `Version ${latest} is available` : 'Up to date', url: rel.html_url };
    } catch (e) {
      return { status: 'error', text: `Couldn’t check: ${e.message}` };
    }
  }
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; ; i++) {
    const c = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(c)) return c;
  }
}

// ---------- startup ----------
const A = new Aphelion();
if (process.env.APHELION_TEST === '1') global.__aphelion = A;   // test hook only (Playwright e2e); never set in releases
if (!A.settings().gpu) app.disableHardwareAcceleration();
app.setAppUserModelId('os.orbit.aphelion');
app.commandLine.appendSwitch('disable-features', 'InterestFeedContentSuggestions,OptimizationHints,MediaRouter');

function urlsFromArgs(argv) {
  return argv.slice(1).filter((a) => /^(https?:|file:|aphelion:)/.test(a) || (fs.existsSync(a) && /\.(html?|pdf|svg)$/i.test(a)))
    .map((a) => (/^[a-z]+:/i.test(a) ? a : pathToFileURL(path.resolve(a)).href));
}

app.on('second-instance', (_e, argv) => {
  const w = A.current();
  const urls = urlsFromArgs(argv);
  if (!w) return A.newWindow({ url: urls[0] });
  for (const u of urls) w.newTab(u);
  if (w.win.isMinimized()) w.win.restore();
  w.win.focus();
});
app.on('open-url', (e, url) => {
  e.preventDefault();
  const w = A.current();
  if (w) w.newTab(url);
  else app.whenReady().then(() => A.newWindow({ url }));
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  session.defaultSession.protocol.handle('aphelion', (req) => A.serveInternal(req, true));  // toolbar UI lives here
  A.engines.load();
  A.mainSession = session.fromPartition('persist:aphelion');
  A.setupSession(A.mainSession, false);
  A.orbitStyle = await platform.orbitStyle();
  nativeTheme.on('updated', () => A.broadcast());
  if (!A.settings().vaultPath) A.store.data.vaultPath = platform.defaultVault();
  registerIpc(A);
  // the authenticator locks with the computer
  for (const ev of ['lock-screen', 'suspend']) powerMonitor.on(ev, () => A.auth.lock());
  const saved = A.settings().restore ? A.sessionStore.data.windows : [];
  const urls = urlsFromArgs(process.argv);
  if (saved.length) for (const r of saved) A.newWindow({ restore: r });
  else A.newWindow({});
  for (const u of urls) A.current().newTab(u);
  setInterval(() => {
    for (const w of A.windows) w.sleepIdle();
  }, 60e3);
  setInterval(async () => {
    const s = await platform.orbitStyle();
    if (s !== A.orbitStyle) {
      A.orbitStyle = s;
      A.broadcast();
    }
  }, 5000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (!A.windows.size) A.newWindow({});
});
let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting) return;
  A.persistSession(true);
  A.store.flush();
  A.bookmarks.flush();
  A.historyStore.flush();
  A.sites.flush();
  A.sessionStore.flush();
  const clear = A.settings().clear;
  if (clear !== 'off') {
    e.preventDefault();
    quitting = true;
    await A.clearData(clear).catch(() => {});
    A.historyStore.flush();
    app.quit();
  }
});
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (ev) => ev.preventDefault());   // no <webview> anywhere
});
app.on('certificate-error', (e, wc, url, error, _cert, cb) => {
  // never accept bad certificates silently: show Aphelion's error page
  cb(false);
  const q = new URLSearchParams({ code: 'cert', desc: error, url });
  setTimeout(() => wc.loadURL(`aphelion://error/?${q}`).catch(() => {}), 0);
});

// ---------- IPC ----------
function registerIpc(a) {
  const fromUi = (e) => [...a.windows].find((w) => w.ui.webContents === e.sender);
  const fromPage = (e) => {
    const t = a.tabByWebContentsId(e.sender.id);
    return t && e.senderFrame && /^aphelion:/.test(e.senderFrame.url) ? t : null;
  };
  const fromTab = (e) => a.tabByWebContentsId(e.sender.id);
  const ui = (name, fn) => ipcMain.handle(`ui:${name}`, (e, ...args) => {
    const w = fromUi(e);
    if (!w) throw new Error('not a browser window');
    return fn(w, ...args);
  });
  const page = (name, fn) => ipcMain.handle(`page:${name}`, (e, ...args) => {
    const t = fromPage(e);
    if (!t) throw new Error('not an Aphelion page');
    return fn(t, ...args);
  });

  // window + tabs
  // Window dragging is done by hand instead of with CSS app-region: on Windows a
  // drag region inside a WebContentsView swallows clicks on the tabs above it.
  let drag = null;
  ipcMain.on('ui:drag', (e, phase, x, y) => {
    const w = fromUi(e);
    if (!w || w.win.isFullScreen() || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (phase === 'start') {
      let b = w.win.getBounds();
      if (w.win.isMaximized()) {
        // pull a maximized window out from under the cursor, keeping the grab point proportional
        const ratio = (x - b.x) / b.width;
        w.win.unmaximize();
        const nb = w.win.getBounds();
        w.win.setPosition(Math.round(x - nb.width * ratio), b.y);
        b = w.win.getBounds();
      }
      drag = { w, x, y, bx: b.x, by: b.y };
    } else if (phase === 'move' && drag?.w === w) {
      w.win.setPosition(Math.round(drag.bx + x - drag.x), Math.round(drag.by + y - drag.y));
    } else if (phase === 'end') {
      drag = null;
    }
  });
  ui('win', (w, act) => ({ min: () => w.win.minimize(), max: () => (w.win.isMaximized() ? w.win.unmaximize() : w.win.maximize()),
                           full: () => w.win.setFullScreen(!w.win.isFullScreen()), close: () => w.win.close() }[act]?.()));
  ui('newTab', (w, url) => void w.newTab(url));
  ui('closeTab', (w, id) => w.close(id));
  ui('selectTab', (w, id) => w.select(id));
  ui('moveTab', (w, id, to) => w.move(id, to));
  ui('navigate', (w, input) => w.navigate(input));
  ui('nav', (w, act) => {
    const wc = w.active()?.wc;
    if (!wc) return;
    ({ back: () => wc.navigationHistory.goBack(), forward: () => wc.navigationHistory.goForward(),
       reload: () => wc.reload(), stop: () => wc.stop(), home: () => w.navigate(a.startPage()) })[act]?.();
  });
  ui('popover', (w, name) => (name ? w.openPopover(name) : w.closePopover()));
  ui('bookmark', (w) => a.toggleBookmark(w));
  ui('menu', (w, act) => {
    w.closePopover();
    ({ newTab: () => w.newTab(), newWindow: () => a.newWindow({}), private: () => a.newWindow({ isPrivate: true }),
       bookmarks: () => w.newTab('aphelion://bookmarks/'), history: () => w.newTab('aphelion://history/'),
       downloads: () => w.openPopover('dl'), settings: () => w.newTab('aphelion://settings/'), find: () => w.startFind(),
       reader: () => a.readerView(w), print: () => w.active()?.wc?.print(), zoomIn: () => w.zoom(1), zoomOut: () => w.zoom(-1),
       zoomReset: () => w.zoom(0), devtools: () => w.active()?.wc?.toggleDevTools(),
       picker: () => w.active()?.wc?.send('aph:picker'), quit: () => app.quit() })[act]?.();
  });
  ui('find', (w, text, opts) => w.findText(text, opts));
  ui('findClose', (w) => w.stopFind());
  ui('bar', (w, id, action, remember) => {
    if (id.startsWith('perm-')) return a.answerPermission(w, id, action === 'allow', remember);
    if (id === 'translate') {
      // the answer holds for the rest of this tab's life: yes = translate every page, no = stop asking
      const t = w.active();
      if (t) t.translate = action === 'translate' ? 'yes' : 'no';
      const to = t && action === 'translate' && translatedUrl(t.url, a.settings().lang);
      if (to) w.navigate(to);
    }
    if (id.startsWith('http-') && action === 'continue') {
      const host = id.slice(5);
      w.pipeline.httpAllowed.add(host);
      w.navigate(`http://${host}/`);
    }
    w.removeBar(id);
  });
  ui('suggestLocal', (w, q) => suggestLocal(a, q));
  ui('suggestRemote', (w, q) => suggestRemote(a, q));
  ui('suggestWarm', () => suggestWarm(a));
  ui('state', (w) => w.state());

  // shield + ad blocker
  ui('shield', (w) => {
    const site = a.siteOf(w.active()?.url || '');
    a.setSitePref(site, 'shield', !(a.sitePrefs(site).shield !== false));
    w.active()?.wc?.reload();
    a.broadcast();
  });
  ui('adsSite', (w) => {
    const site = a.siteOf(w.active()?.url || '');
    a.setSitePref(site, 'ads', !(a.sitePrefs(site).ads !== false));
    w.active()?.wc?.reload();
    a.broadcast();
  });
  ui('setting', (w, key, value) => a.setSetting(key, value));
  ui('adsInfo', (w) => ({ page: w.active()?.counts.ads || 0, total: a.adsTotal, lists: a.engines.manifest,
                          easy: a.settings().easy, annoy: a.settings().annoy, social: a.settings().social, on: a.settings().ads }));
  ui('picker', (w) => {
    w.closePopover();
    w.active()?.wc?.send('aph:picker');
  });

  // authenticator
  ui('totpState', () => a.auth.state());
  ui('totpSetup', (w, pw) => a.auth.setup(pw));
  ui('totpUnlock', (w, pw) => a.auth.unlock(pw));
  ui('totpLock', () => a.auth.lock());
  ui('totpChangePassword', (w, oldPw, newPw) => a.auth.changePassword(oldPw, newPw));
  ui('totp', () => a.totpCodes());
  ui('totpAdd', (w, input, name) => a.addTotp(input, name));
  ui('totpRemove', (w, id) => a.writeTotp(a.readTotp().filter((x) => x.id !== id)));
  ui('totpCopy', (w, id) => {
    const c = a.totpCodes().find((x) => x.id === id);
    if (c) a.copySecret(c.code);
    return Boolean(c);
  });
  ui('totpScan', async (w) => {
    const wc = w.active()?.wc;
    if (!wc) return null;
    const img = await wc.capturePage();
    const jsQR = require('jsqr');
    const { width, height } = img.getSize();
    const bmp = img.toBitmap();   // BGRA
    const rgba = new Uint8ClampedArray(bmp.length);
    for (let i = 0; i < bmp.length; i += 4) {
      rgba[i] = bmp[i + 2];
      rgba[i + 1] = bmp[i + 1];
      rgba[i + 2] = bmp[i];
      rgba[i + 3] = 255;
    }
    const code = jsQR(rgba, width, height);
    if (!code || !code.data.startsWith('otpauth://')) return null;
    return a.addTotp(code.data);
  });

  // KeePass
  ui('vault', (w) => ({ locked: a.vault.locked, path: a.settings().vaultPath, file: path.basename(a.settings().vaultPath || '') }));
  ui('vaultChoose', async (w) => {
    const r = await dialog.showOpenDialog({ title: 'Choose your KeePass database', properties: ['openFile'],
                                            filters: [{ name: 'KeePass database', extensions: ['kdbx'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    a.setSetting('vaultPath', r.filePaths[0]);
    return r.filePaths[0];
  });
  ui('vaultUnlock', async (w, pw) => {
    const p = a.settings().vaultPath;
    if (!p) throw new Error('Choose a .kdbx database first');
    await a.vault.unlock(p, pw);
    a.broadcast();
    for (const t of w.tabs) t.decorate();
    return true;
  });
  ui('vaultLock', () => {
    a.vault.lock();
    a.broadcast();
  });
  ui('vaultSearch', (w, q) => a.vault.search(q, hostOf(w.active()?.url || '')));
  ui('vaultFill', (w, id) => {
    const t = w.active();
    if (!t?.wc || !/^https:/.test(t.url)) throw new Error('Logins are only filled on secure (https) pages');
    const { user, password } = a.vault.secret(id);
    t.wc.send('aph:fill', { user, password });
    w.closePopover();
    t.wc.focus();
  });
  ui('vaultCopy', (w, id, field) => {
    const sec = a.vault.secret(id);
    a.copySecret(field === 'user' ? sec.user : sec.password);
  });
  ui('generate', () => {
    const pw = generatePassword();
    a.copySecret(pw);
    return pw;
  });

  // notes
  ui('notes', () => a.notesInfo());
  ui('notesSave', (w, text) => a.saveNotes(String(text).slice(0, 2e6)));
  ui('clip', (w) => {
    const t = w.active();
    return t ? `→ [${(t.title || t.url).replace(/[[\]]/g, '')}](${t.url})` : '';
  });

  // downloads
  ui('downloads', () => a.downloadList());
  ui('dl', (w, id, act) => {
    const d = a.downloads.find((x) => x.id === id);
    if (!d) return;
    ({ open: () => shell.openPath(d.path), show: () => shell.showItemInFolder(d.path), cancel: () => d.item.cancel(),
       pause: () => d.item.pause(), resume: () => d.item.resume() })[act]?.();
  });
  ui('dlClear', () => {
    a.downloads = a.downloads.filter((d) => d.state === 'progressing' || d.state === 'paused');
    a.broadcast();
    return a.downloadList();
  });

  // media
  ui('media', () => a.mediaTabs().map((t) => ({ id: t.id, title: t.title, host: hostOf(t.url), playing: t.playing, audible: t.audible })));
  ui('mediaControl', (w, tabId, act) => {
    const t = a.mediaTabs().find((x) => x.id === tabId);
    if (!t) return;
    if (act === 'focus') {
      t.win.select(t.id);
      t.win.win.focus();
    } else t.wc.send('aph:media', act);
  });

  // internal pages (aphelion://...)
  page('settings', () => a.publicSettings());
  page('setSetting', (t, key, value) => a.setSetting(key, value));
  page('chooseFolder', async (t, key) => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (!r.canceled && r.filePaths[0] && key === 'downloadDir') a.setSetting('downloadDir', r.filePaths[0]);
    return a.publicSettings();
  });
  page('chooseVault', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'KeePass', extensions: ['kdbx'] }] });
    if (!r.canceled && r.filePaths[0]) a.setSetting('vaultPath', r.filePaths[0]);
    return a.publicSettings();
  });
  page('history', (t, q) => a.history.search(q));
  page('historyRemove', (t, url) => a.history.remove(url));
  page('clearData', (t, what) => a.clearData(what));
  page('bookmarks', () => a.bookmarks.data.items);
  page('bookmarkRemove', (t, url) => {
    a.bookmarks.data.items = a.bookmarks.data.items.filter((b) => b.url !== url);
    a.bookmarks.save();
    a.broadcast();
    return a.bookmarks.data.items;
  });
  page('topSites', () => {
    const n = a.newtab.data;
    const max = n.columns * n.rows;
    let list;
    if (n.source === 'mine') {
      list = n.mine.map((m) => ({ url: m.url, title: m.title, host: hostOf(m.url), mine: true }));
    } else {
      const hidden = new Set(n.hidden);
      const mine = n.mine.map((m) => ({ url: m.url, title: m.title, host: hostOf(m.url), mine: true }));
      const bm = a.bookmarks.data.items.map((b) => ({ url: b.url, title: b.title, host: hostOf(b.url) }));
      const seen = new Set();
      list = [...mine, ...bm, ...a.history.topSites(40)].filter((x) => {
        if (!x.host || seen.has(x.host) || (!x.mine && hidden.has(x.host))) return false;
        seen.add(x.host);
        return true;
      });
    }
    return list.slice(0, max).map((x) => ({ ...x, icon: a.icons.get(x.host) }));
  });
  page('newtab', () => ({ ...a.newtab.data, imageVersion: a.newtabImageVersion || 0 }));
  page('newtabSet', (t, patch) => {
    a.setNewtab(patch);
    a.pageEvent('newtab', null);
  });
  page('newtabShortcut', (t, op, arg) => {
    const n = a.newtab.data;
    if (op === 'add') {
      const raw = String(arg?.url || '').trim();
      const url = /\s/.test(raw) ? null : toUrl(raw, 'none');
      const host = url ? hostOf(url) : '';
      if (!url || !/^https?:\/\//.test(url) || !(host.includes('.') || host === 'localhost') || url.includes('duckduckgo.com/?q=')) {
        throw new Error('enter a web address, like example.com');
      }
      if (n.mine.length >= 32) throw new Error('32 shortcuts at most');
      const title = String(arg?.title || '').trim().slice(0, 40) || hostOf(url).replace(/^www\./, '');
      n.mine = [...n.mine.filter((m) => m.url !== url), { title, url }];
    } else if (op === 'remove') {
      const host = String(arg || '');
      n.mine = n.mine.filter((m) => hostOf(m.url) !== host);
      if (!n.hidden.includes(host)) n.hidden = [...n.hidden, host].slice(-200);
    } else if (op === 'rename') {
      n.mine = n.mine.map((m) => (hostOf(m.url) === arg?.host ? { ...m, title: String(arg.title || '').trim().slice(0, 40) || m.title } : m));
    } else if (op === 'restore') {
      n.hidden = [];
    }
    a.newtab.save();
    a.pageEvent('newtab', null);
  });
  page('newtabImage', (t, dataUrl) => {
    if (dataUrl === null) {
      fs.rmSync(a.newtabImage, { force: true });
      a.setNewtab({ image: false });
    } else {
      const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
      if (!m) throw new Error('pick a PNG, JPEG, WebP or GIF picture');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 15 * 1024 * 1024) throw new Error('the picture is larger than 15 MB');
      fs.writeFileSync(a.newtabImage, buf, { mode: 0o600 });
      fs.writeFileSync(`${a.newtabImage}.type`, m[1]);
      a.setNewtab({ image: true });
    }
    a.newtabImageVersion = Date.now();
    a.pageEvent('newtab', null);
  });
  page('open', (t, url, where) => {
    const target = toUrl(url, a.settings().engine);
    // internal pages may open web pages, searches and the browsing pages, nothing else
    if (!target || !(/^https?:/.test(target) || /^aphelion:\/\/(newtab|settings|history|bookmarks)\//.test(target))) return;
    if (where === 'tab') t.win.newTab(target);
    else t.wc.loadURL(target).catch(() => {});
  });
  page('reader', () => a.readerCache || null);
  page('updateLists', async () => {
    await a.engines.update(net.fetch.bind(net), (p) => a.pageEvent('lists-progress', p));
    for (const w of a.windows) for (const tab of w.tabs) tab.decorate();
    return a.publicSettings();
  });
  page('checkUpdates', () => a.checkUpdates());
  page('makeDefault', () => {
    const ok = app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https');
    return ok;
  });
  page('picked', () => a.sites.data.picked);
  page('pickedRemove', (t, host, sel) => {
    a.sites.data.picked[host] = (a.sites.data.picked[host] || []).filter((x) => x !== sel);
    if (!a.sites.data.picked[host].length) delete a.sites.data.picked[host];
    a.sites.save();
    return a.sites.data.picked;
  });
  page('perms', () => a.sites.data.perms);
  page('permsReset', (t, host) => {
    delete a.sites.data.perms[host];
    a.sites.save();
    return a.sites.data.perms;
  });
  page('vaultInfo', () => ({ locked: a.vault.locked, path: a.settings().vaultPath }));
  page('totpList', () => a.totpCodes().map(({ id, name, account }) => ({ id, name, account })));
  page('totpRemove', (t, id) => a.writeTotp(a.readTotp().filter((x) => x.id !== id)));
  page('totpAdd', (t, input, name) => a.addTotp(input, name));
  page('retry', (t, url) => {
    if (/^https?:/.test(url)) t.wc.loadURL(url).catch(() => {});
  });
  page('httpContinue', (t, url) => {
    const h = hostOf(url);
    if (!h) return;
    t.win.pipeline.httpAllowed.add(h);
    t.wc.loadURL(url.replace(/^https:/, 'http:')).catch(() => {});
  });

  // content preload (web pages): only data the page itself produced, validated here
  ipcMain.on('aph:article', (e, has) => {
    const t = fromTab(e);
    if (t && e.senderFrame === e.sender.mainFrame) {
      t.hasArticle = Boolean(has);
      t.win.changed();
    }
  });
  ipcMain.on('aph:lang', (e, lang) => {
    const t = fromTab(e);
    const s = a.settings();
    if (!t || e.senderFrame !== e.sender.mainFrame || !s.translate || typeof lang !== 'string') return;
    const pageLang = lang.toLowerCase().split('-')[0];
    const foreign = pageLang && pageLang !== s.lang.split('-')[0] && /^[a-z]{2,3}$/.test(pageLang);
    if (!foreign || t.translate === 'no' || hostOf(t.url).endsWith('.translate.goog')) return;
    if (t.translate === 'yes') {
      const to = translatedUrl(t.url, s.lang);
      if (to) t.wc.loadURL(to);
      return;
    }
    // ask once per tab; the bar goes away by itself if the user just moves on
    if (t.translateAsked || t.id !== t.win.activeId) return;
    t.translateAsked = true;
    t.win.addBar({ id: 'translate', kind: 'translate', text: `This page is in ${langName(pageLang)}. Translate pages in this tab?`,
                   actions: [['Translate', 'translate'], ['No thanks', 'dismiss']] });
  });
  ipcMain.on('aph:picked', (e, selector) => {
    const t = fromTab(e);
    if (!t || typeof selector !== 'string' || selector.length > 500 || /[{}<>]/.test(selector)) return;
    const host = hostOf(t.url);
    const list = a.sites.data.picked[host] || [];
    if (!list.includes(selector)) list.push(selector);
    a.sites.data.picked[host] = list;
    a.sites.save();
    t.wc.insertCSS(`${selector} { display: none !important; }`, { cssOrigin: 'user' }).catch(() => {});
  });
  ipcMain.on('aph:login-submitted', async (e, data) => {
    const t = fromTab(e);
    const s = a.settings();
    if (!t || !s.save || t.session.isPrivate || !/^https:/.test(t.url) || a.vault.locked) return;
    if (typeof data?.user !== 'string' || typeof data?.password !== 'string' || !data.password || data.password.length > 1024) return;
    const host = hostOf(t.url);
    const existing = a.vault.search('', host).items.some((x) => x.user === data.user && x.url && hostOf(/^https?:/.test(x.url) ? x.url : `https://${x.url}`) === host);
    if (existing) return;
    a.pendingLogin = { host, url: `https://${host}/`, user: data.user.slice(0, 256), password: data.password, tab: t.id };
    t.win.addBar({ id: 'savepw', kind: 'password', text: `Save the login for ${host} to your KeePass database?`,
                   actions: [['Save', 'save'], ['Not now', 'dismiss']] });
  });
  ipcMain.handle('ui:savePending', async (e, yes) => {
    const w = fromUi(e);
    const p = a.pendingLogin;
    a.pendingLogin = null;
    w?.removeBar('savepw');
    if (!yes || !p) return false;
    await a.vault.addLogin({ title: p.host, url: p.url, user: p.user, password: p.password });
    return true;
  });
  ipcMain.on('aph:autofill-request', (e) => {
    const t = fromTab(e);
    if (!t || !a.settings().autofill || a.vault.locked || !/^https:/.test(t.url)) return;
    const m = a.vault.search('', hostOf(t.url));
    if (m.label.startsWith('Matches') && m.items.length === 1) {
      const { user, password } = a.vault.secret(m.items[0].id);
      t.wc.send('aph:fill', { user, password, auto: true });
    }
  });
  ipcMain.on('aph:caret-key', (e) => {
    const t = fromTab(e);
    if (t) a.setSetting('caret', !a.settings().caret);
  });
}

const LANG_NAMES = { en: 'English', nl: 'Dutch', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
                     pl: 'Polish', sv: 'Swedish', tr: 'Turkish', ja: 'Japanese', zh: 'Chinese', ru: 'Russian', ar: 'Arabic',
                     ko: 'Korean', uk: 'Ukrainian', da: 'Danish', no: 'Norwegian', fi: 'Finnish', cs: 'Czech', el: 'Greek' };
// Google's page proxy: https://www.example.com/a -> https://www-example-com.translate.goog/a?_x_tr_sl=auto&...
// Links inside a translated page stay on the proxy, so the whole visit stays translated.
function translatedUrl(url, lang) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.port || u.hostname.endsWith('.translate.goog')) return null;
  const tl = lang.split('-')[0];
  const host = u.hostname.replace(/-/g, '--').replace(/\./g, '-');
  const q = new URLSearchParams(u.search);
  q.set('_x_tr_sl', 'auto'); q.set('_x_tr_tl', tl); q.set('_x_tr_hl', tl);
  return `https://${host}.translate.goog${u.pathname}?${q}${u.hash}`;
}

function langName(code) {
  return LANG_NAMES[code] || code.toUpperCase();
}

// Address-bar suggestions come in two parts so typing never waits on the network:
// local matches (bookmarks, history) answer at once, engine phrases follow.
function suggestLocal(a, q) {
  const s = a.settings();
  const query = String(q || '').trim();
  const out = [];
  if (!query) return out;
  const lower = query.toLowerCase();
  for (const b of a.bookmarks.data.items) {
    if (out.length >= 3) break;
    if (b.url.toLowerCase().includes(lower) || b.title.toLowerCase().includes(lower)) out.push({ kind: 'bookmark', title: b.title, url: b.url });
  }
  for (const h of a.history.search(query, 5)) {
    if (out.length >= 6) break;
    if (!out.some((o) => o.url === h.url)) out.push({ kind: 'history', title: h.title, url: h.url });
  }
  if (s.preload && out[0]?.url?.startsWith('https:')) a.mainSession.preconnect({ url: out[0].url, numSockets: 1 });
  return out;
}

const remoteCache = new Map();  // `${engine}\n${query}` -> phrases; small LRU
async function suggestRemote(a, q) {
  const s = a.settings();
  const query = String(q || '').trim();
  const eng = schema.ENGINES[s.engine];
  if (!query || !s.suggest || !eng?.suggest || /^[a-z]+:\/\//i.test(query)) return [];
  const key = `${s.engine}\n${query.toLowerCase()}`;
  let phrases = remoteCache.get(key);
  if (!phrases) {
    try {
      const res = await net.fetch(eng.suggest.replace('%s', encodeURIComponent(query)), { signal: AbortSignal.timeout(1500) });
      const data = await res.json();
      const list = Array.isArray(data) ? (Array.isArray(data[1]) ? data[1] : data.map((x) => x?.phrase)) : [];
      phrases = list.filter((x) => typeof x === 'string').slice(0, 5);
    } catch {
      return [];  // offline or blocked: local matches are enough
    }
    remoteCache.set(key, phrases);
    if (remoteCache.size > 300) remoteCache.delete(remoteCache.keys().next().value);
  }
  return phrases.map((phrase) => ({ kind: 'search', title: phrase, url: toUrl(phrase, s.engine) }));
}

// open the connection to the suggestion server when the address bar gets focus,
// so the first keystroke does not pay for DNS + TLS
function suggestWarm(a) {
  const s = a.settings();
  const eng = schema.ENGINES[s.engine];
  if (!s.suggest || !eng?.suggest) return;
  try {
    a.mainSession.preconnect({ url: new URL(eng.suggest.replace('%s', 'a')).origin, numSockets: 1 });
  } catch { /* bad engine URL: nothing to warm */ }
}

module.exports = { Aphelion };
