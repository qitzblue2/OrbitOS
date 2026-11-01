// ORBIT desktop app. One install gives you:
//  - the ORBIT server, running locally inside the app
//  - this computer paired as a device automatically (the built-in Companion)
//  - on-device wake word, speech-to-text and text-to-speech
//  - a tray icon, a global shortcut and a floating overlay, so ORBIT works with the window closed
const ROOT_DIR = require('node:path').resolve(__dirname, '..');
const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, session, systemPreferences, utilityProcess, screen, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
// ESM import() needs file:// URLs; plain paths break on Windows (C:\...).
const load = (...parts) => import(pathToFileURL(path.join(ROOT_DIR, ...parts)).href);
const fs = require('node:fs');
const models = require('./models.js');

const ROOT = ROOT_DIR;
const ICON = path.join(__dirname, 'icons', 'icon.png');
let orbit, port, token, main, overlay, tray, worker, quitting = false;
const state = { listening: false, speechReady: false, phase: 'idle', settings: {} };

if (process.env.ORBIT_USER_DATA) app.setPath('userData', process.env.ORBIT_USER_DATA); // portable / testing
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showMain());

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'app-settings.json');
function loadSettings() {
  try { state.settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { state.settings = {}; }
  state.settings = { listenOnStart: false, sensitivity: 0.08, voice: 'alan', ...state.settings };
}
function saveSettings() { fs.writeFileSync(settingsFile(), JSON.stringify(state.settings, null, 2)); }

// ---------- server + built-in companion ----------
async function startServer() {
  process.env.ORBIT_DATA_DIR = path.join(app.getPath('userData'), 'data');
  process.env.ORBIT_ENV_FILE = path.join(app.getPath('userData'), '.env'); // writable, unlike the install folder
  const { config } = await load('server', 'config.js');
  const { createOrbit } = await load('server', 'index.js');
  orbit = createOrbit(config);
  token = config.adminToken;
  try { ({ port } = await orbit.listen(config.port, '127.0.0.1')); }
  catch { ({ port } = await orbit.listen(0, '127.0.0.1')); } // preferred port busy
}

async function startCompanion() {
  const { execute } = await load('companion', 'agent.js');
  const WebSocket = require('ws');
  const os = require('node:os');
  const file = path.join(app.getPath('userData'), 'companion.json');
  let conf = null;
  try { conf = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!conf || !orbit.devices.authenticate(conf.token)) {
    const { code } = orbit.devices.createPairingCode();
    const platform = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform] || process.platform;
    const paired = orbit.devices.pair({ code, name: os.hostname().replace(/\.local$/, ''), platform });
    conf = { token: paired.token, id: paired.device.id, local: {} };
    fs.writeFileSync(file, JSON.stringify(conf, null, 2), { mode: 0o600 });
  }
  const connect = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/device`, { headers: { authorization: `Bearer ${conf.token}` } });
    ws.on('message', async (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'command') ws.send(JSON.stringify({ type: 'result', id: m.id, ...(await execute(m.capability, m.params, conf.local)) }));
    });
    ws.on('open', async () => { const r = await execute('system.status', {}, conf.local); ws.send(JSON.stringify({ type: 'status', status: r.data })); });
    ws.on('close', (code) => { if (code !== 4001 && !quitting) setTimeout(connect, 2000); });
    ws.on('error', () => {});
  };
  connect();
}

// ---------- on-device speech ----------
function modelCandidates() {
  return [path.join(process.resourcesPath || '', 'models'), path.join(app.getPath('userData'), 'models'), path.join(ROOT, 'models')];
}
async function startSpeech() {
  let dir = models.locate(modelCandidates());
  if (!dir) {
    const target = path.join(app.getPath('userData'), 'models');
    broadcast('models', { status: 'downloading', fraction: 0 });
    try {
      dir = await models.download(target, (p) => broadcast('models', { status: 'downloading', name: p.name, fraction: (p.index + p.fraction) / p.count }));
    } catch (e) { broadcast('speech-error', `Couldn't download the voice models: ${e.message}`); return; }
  }
  worker = utilityProcess.fork(path.join(__dirname, 'speech-worker.js'), [], { serviceName: 'ORBIT speech' });
  worker.on('message', onSpeech);
  worker.on('exit', () => { state.speechReady = false; if (!quitting) setTimeout(startSpeech, 1000); });
  state.modelsDir = dir;
  const localVoice = state.settings.voice.startsWith('openai:') ? (state.settings.localVoice || 'alan') : state.settings.voice;
  worker.postMessage({ type: 'boot', modelsDir: dir, sensitivity: state.settings.sensitivity, voice: localVoice, voiceDirs: [path.join(app.getPath('userData'), 'models')] });
}

const pendingSpeech = new Map();
function onSpeech(m) {
  switch (m.type) {
    case 'ready':
      state.speechReady = true; broadcast('speech-ready', { tts: m.tts }); broadcast('models', { status: 'ready' });
      if (state.settings.listenOnStart) broadcast('mic', { enabled: true });
      break;
    case 'error': broadcast('speech-error', m.message); break;
    case 'wake': showOverlay(); toOverlay({ phase: 'listening', heard: '' }); broadcast('wake', m.data); break;
    case 'listening': broadcast('listening', m.data); break;
    case 'partial': toOverlay({ heard: m.data }); broadcast('partial', m.data); break;
    case 'utterance': toOverlay({ heard: m.data, phase: m.data ? 'processing' : 'idle' }); broadcast('utterance', m.data); break;
    case 'voice': { const done = state.voiceWait; state.voiceWait = null; done?.(m); break; }
    case 'speech': { const done = pendingSpeech.get(m.id); pendingSpeech.delete(m.id); done?.(m.samples ? { samples: Float32Array.from(m.samples), sampleRate: m.sampleRate } : null); break; }
  }
}
const toWorker = (msg) => worker && state.speechReady && worker.postMessage(msg);

ipcMain.on('audio', (_e, samples) => { if (state.listening) toWorker({ type: 'audio', samples: Array.from(samples) }); });
ipcMain.on('listening', (_e, on) => { state.listening = !!on; updateTray(); if (!on) { toWorker({ type: 'cancel' }); hideOverlaySoon(0); } });
ipcMain.on('ptt', (_e, down) => { if (down) showOverlay(); toWorker({ type: 'ptt', down }); });
ipcMain.on('followUp', (_e, ms) => toWorker({ type: 'followUp', ms }));
ipcMain.on('cancel', () => toWorker({ type: 'cancel' }));
ipcMain.on('sensitivity', (_e, v) => { state.settings.sensitivity = Math.max(0.02, Math.min(0.4, +v)); saveSettings(); if (worker) worker.kill(); });
const localSpeak = (text, speed) => new Promise((resolve) => {
  if (!state.speechReady) return resolve(null);
  const id = Math.random().toString(36).slice(2);
  pendingSpeech.set(id, resolve);
  worker.postMessage({ type: 'speak', id, text, speed });
});

// ---------- voices ----------
const { VOICES, voiceInstalled } = require('./speech.js');
const OPENAI_VOICES = [['ash', 'Ash', 'warm, steady'], ['onyx', 'Onyx', 'deep, authoritative'], ['sage', 'Sage', 'calm, thoughtful'], ['coral', 'Coral', 'bright, friendly'], ['nova', 'Nova', 'energetic'], ['echo', 'Echo', 'smooth'], ['fable', 'Fable', 'British, storyteller'], ['alloy', 'Alloy', 'neutral'], ['shimmer', 'Shimmer', 'gentle']];
const openaiKey = () => orbit?.keyring.data.keys.find((k) => k.provider === 'openai' && k.enabled);
const voiceDirs = () => [state.modelsDir, path.join(app.getPath('userData'), 'models')];

ipcMain.handle('voices', () => {
  const local = Object.entries(VOICES).map(([id, v]) => ({ id, label: v.label, desc: v.desc, kind: v.engine === 'kokoro' ? 'natural' : v.bundled ? 'built-in' : 'download', installed: voiceInstalled(voiceDirs(), id), sizeMB: v.sizeMB || 0 }));
  const cloud = OPENAI_VOICES.map(([id, label, desc]) => ({ id: `openai:${id}`, label, desc: `${desc} · OpenAI cloud`, kind: 'cloud', installed: !!openaiKey() }));
  return { current: state.settings.voice, voices: [...local, ...cloud] };
});

ipcMain.handle('setVoice', async (_e, id) => {
  if (id.startsWith('openai:')) {
    if (!openaiKey()) throw new Error('Add an OpenAI key under AI configuration to use cloud voices.');
    state.settings.voice = id; saveSettings(); return { voice: id };
  }
  if (!VOICES[id]) throw new Error('Unknown voice');
  if (!voiceInstalled(voiceDirs(), id)) {
    await models.downloadVoice(path.join(app.getPath('userData'), 'models'), id, (p) => broadcast('voice-download', { id, fraction: p.fraction }));
    broadcast('voice-download', { id, fraction: 1 });
  }
  const res = await new Promise((resolve) => { state.voiceWait = resolve; worker.postMessage({ type: 'setVoice', voice: id, benchmark: true }); });
  state.settings.voice = res.voice; state.settings.localVoice = res.voice; saveSettings();
  return { voice: res.voice, rtf: res.rtf, slow: res.rtf != null && res.rtf > 0.6 };
});

// Cloud voice: OpenAI text-to-speech, raw 24 kHz PCM. Any failure falls back to the on-device voice.
async function cloudSpeak(text, voice, speed) {
  const k = openaiKey();
  if (!k) throw new Error('no OpenAI key');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${orbit.keyring.secretOf(k)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'pcm', speed,
      instructions: 'Speak like a calm, confident, quietly witty personal assistant. Smooth, natural pacing.' }),
  });
  if (!res.ok) throw new Error(`OpenAI voice ${res.status}`);
  const pcm = new Int16Array(await res.arrayBuffer());
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
  return { samples, sampleRate: 24000 };
}

ipcMain.handle('speak', async (_e, text, speed) => {
  const v = state.settings.voice;
  if (v.startsWith('openai:')) {
    try { return await cloudSpeak(text, v.slice(7), speed); }
    catch (e) { log('cloud voice failed, using on-device voice:', e.message); }
  }
  return localSpeak(text, speed);
});
ipcMain.handle('info', () => ({ speechReady: state.speechReady, launchAtLogin: app.getLoginItemSettings().openAtLogin, sensitivity: state.settings.sensitivity, listenOnStart: state.settings.listenOnStart, version: app.getVersion() }));
ipcMain.handle('launchAtLogin', (_e, on) => { app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true, args: ['--hidden'] }); return app.getLoginItemSettings().openAtLogin; });
ipcMain.on('report', (_e, s) => {
  state.phase = s.phase || state.phase;
  if (s.listening !== undefined) { state.listening = s.listening; state.settings.listenOnStart = s.listening; saveSettings(); }
  toOverlay(s); updateTray();
  if (s.phase === 'idle' && !s.reply) hideOverlaySoon();
  if (s.reply !== undefined) hideOverlaySoon(6000);
});
ipcMain.on('show-main', () => showMain());
ipcMain.on('overlay-stop', () => { broadcast('mic', { enabled: false }); overlay?.hide(); });

// ---------- windows ----------
function broadcast(channel, data) { if (main && !main.isDestroyed()) main.webContents.send(channel, data); }
function dashboardUrl(view = 'dashboard') { return `http://127.0.0.1:${port}/#${view}?token=${encodeURIComponent(token)}`; }

function createMain({ show }) {
  main = new BrowserWindow({
    width: 1440, height: 900, minWidth: 380, minHeight: 600, show: false, title: 'ORBIT', icon: ICON,
    backgroundColor: '#03060d', titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  main.loadURL(dashboardUrl());
  main.once('ready-to-show', () => { if (show) main.show(); });
  // Closing the window keeps ORBIT running in the tray, so the wake word still works.
  main.on('close', (e) => { if (!quitting) { e.preventDefault(); main.hide(); } });
  main.webContents.setWindowOpenHandler(({ url }) => { require('electron').shell.openExternal(url); return { action: 'deny' }; });
}
function showMain() { if (!main) return; main.show(); main.focus(); }

function createOverlay() {
  overlay = new BrowserWindow({
    width: 520, height: 132, frame: false, transparent: true, resizable: false, show: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true, sandbox: true },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadURL(`http://127.0.0.1:${port}/overlay.html`);
}
let overlayTimer;
function showOverlay() {
  clearTimeout(overlayTimer);
  if (!overlay || (main?.isVisible() && main.isFocused())) return; // the dashboard already shows everything
  const { workArea } = screen.getPrimaryDisplay();
  overlay.setPosition(Math.round(workArea.x + (workArea.width - 520) / 2), workArea.y + 24);
  overlay.showInactive();
}
function hideOverlaySoon(ms = 1500) { clearTimeout(overlayTimer); overlayTimer = setTimeout(() => overlay?.hide(), ms); }
function toOverlay(d) { if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay', d); }

// ---------- tray + shortcut ----------
function updateTray() {
  if (!tray) return;
  tray.setToolTip(state.listening ? 'ORBIT: listening for "Hey Orbit"' : 'ORBIT: mic off');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ORBIT', click: showMain },
    { type: 'separator' },
    { label: 'Listen for "Hey Orbit"', type: 'checkbox', checked: state.listening, enabled: state.speechReady, click: (i) => broadcast('mic', { enabled: i.checked }) },
    { label: `Push to talk   ${process.platform === 'darwin' ? '⌥ Space' : 'Alt+Space'}`, enabled: false },
    { type: 'separator' },
    { label: 'Start ORBIT when I log in', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, openAsHidden: true, args: ['--hidden'] }) },
    { type: 'separator' },
    { label: 'Quit ORBIT', click: () => { quitting = true; app.quit(); } },
  ]));
}
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'icons', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  tray = new Tray(img);
  tray.on('click', showMain);
  updateTray();
}

// ---------- failures are shown, never silent ----------
function logFile() { try { return path.join(app.getPath('userData'), 'orbit.log'); } catch { return null; } }
function log(...a) { const f = logFile(); if (f) try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, `[${new Date().toISOString()}] ${a.join(' ')}\n`); } catch {} }
function fatal(err) {
  log('FATAL', err?.stack || err);
  if (process.env.ORBIT_SMOKE) { console.error(err); app.exit(1); return; }
  dialog.showErrorBox('ORBIT could not start', `${err?.message || err}\n\nDetails were saved to:\n${logFile()}`);
  app.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

// ---------- lifecycle ----------
app.whenReady().then(async () => {
  log('starting', app.getVersion(), process.platform, process.arch);
  loadSettings();
  if (process.platform === 'darwin') { app.dock?.setIcon(ICON); await systemPreferences.askForMediaAccess('microphone').catch(() => false); }
  await startServer();
  // Only our own local pages may use the microphone.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media' && wc.getURL().startsWith(`http://127.0.0.1:${port}/`)));
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => perm === 'media' && origin === `http://127.0.0.1:${port}`);
  createMain({ show: !process.argv.includes('--hidden') });
  createOverlay();
  createTray();
  startCompanion().catch((e) => console.error('companion:', e));
  startSpeech();
  // Global push-to-talk: press once to talk, again to send. Works from any app.
  let pttDown = false;
  globalShortcut.register('Alt+Space', () => { pttDown = !pttDown; broadcast('ptt-toggle', pttDown); if (pttDown) showOverlay(); });
  log('started on port', port);
  // CI smoke test: prove the packaged app boots its server and dashboard, then exit.
  if (process.env.ORBIT_SMOKE) {
    main.webContents.once('did-finish-load', async () => {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()).catch((e) => ({ error: e.message }));
      const page = await main.webContents.executeJavaScript('document.title + " " + !!window.orbitNative');
      fs.writeFileSync(process.env.ORBIT_SMOKE, JSON.stringify({ health, page, platform: process.platform }));
      quitting = true; app.exit(health.ok ? 0 : 1);
    });
  }
}).catch(fatal);
app.on('activate', showMain);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', async () => { globalShortcut.unregisterAll(); worker?.kill(); await orbit?.close(); });
app.on('window-all-closed', (e) => e.preventDefault());
