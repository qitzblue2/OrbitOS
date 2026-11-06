// ORBIT server: dashboard + REST API + realtime WebSocket for the dashboard and Companion agents.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { JsonStore } from './store.js';
import { AuditLog } from './audit.js';
import { Memory, MEMORY_KINDS } from './memory.js';
import { DeviceRegistry, CAPABILITIES } from './devices.js';
import { Brain } from './brain/index.js';
import { Keyring, friendly } from './brain/keyring.js';
import { PROVIDERS } from './brain/catalog.js';
import { testVoiceKey } from './voice/cloud.js';
import { createHome } from './smarthome/index.js';
import { Automations } from './automations.js';
import { Engine } from './engine.js';
import { Agent } from './agent.js';

export function createOrbit(cfg = config) {
  const settingsStore = new JsonStore(cfg.dataDir, 'settings', {
    userName: '', tone: 'composed', fullControl: false, customInstructions: '', voice: { name: '', rate: 1.05, pitch: 0.95 },
    wakeWord: true, proactive: { briefing: true, reminders: true, deviceAlerts: true }, retentionDays: 30,
  });
  const settings = { get data() { return settingsStore.data; }, ackTimeoutMs: cfg.deviceAckTimeoutMs };
  const audit = new AuditLog(cfg.dataDir);
  const memory = new Memory(cfg.dataDir);
  const devices = new DeviceRegistry(cfg.dataDir);
  const keyring = new Keyring(cfg.dataDir);
  // One-time migration: a key from .env becomes the first keyring entry.
  if (cfg.ai.anthropicKey && !keyring.data.keys.some((k) => k.fp === keyring.fingerprint(cfg.ai.anthropicKey))) {
    try { keyring.add({ provider: 'anthropic', key: cfg.ai.anthropicKey, label: 'Anthropic (from .env)' }); } catch {}
  }
  const brain = new Brain(cfg.ai, keyring);
  brain.warmModels();
  const home = createHome(cfg);
  const automations = new Automations(cfg.dataDir);
  const engine = new Engine({ brain, memory, devices, home, automations, audit, settings });
  engine.agent = new Agent({ engine, brain, memory, devices, audit, settings });
  const uiClients = new Set();
  const broadcast = (type, data) => { const m = JSON.stringify({ type, ...data }); for (const c of uiClients) if (c.readyState === 1) c.send(m); };

  const webRoot = path.join(cfg.root, 'web');
  // Version stamp of the dashboard files: changes whenever any file changes. It is added to every
  // script/style address, so browsers and CDNs can never keep running an old copy after an update.
  const VERSION = (() => {
    const h = crypto.createHash('sha1');
    for (const f of fs.readdirSync(webRoot).sort()) { const st = fs.statSync(path.join(webRoot, f)); if (st.isFile()) h.update(`${f}:${st.size}:${st.mtimeMs}`); }
    return h.digest('hex').slice(0, 10);
  })();
  const stamp = (text, ext) => (ext === '.html'
    ? text.replace(/(src|href)="((?:app|core|voice|overlay)\.js|app\.css|overlay\.css|manifest\.webmanifest)"/g, `$1="$2?v=${VERSION}"`)
    : ext === '.js' ? text.replace(/(from\s+|import\(\s*|addModule\(\s*|register\(\s*)'(\.\/)?([\w-]+\.js)'/g, `$1'./$3?v=${VERSION}'`).replace("'orbit-shell-v2'", `'orbit-shell-${VERSION}'`) : text);
  const MIME = { '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
  const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  // Phones: paired once with a short code, each with its own revocable key (only a hash is stored).
  const phones = new JsonStore(cfg.dataDir, 'phones', { phones: [], codes: [] });
  const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const phoneFor = (t) => { const h = hash(t); return phones.data.phones.find((p) => safeEq(p.tokenHash, h)); };
  const isAdmin = (req, url) => {
    const t = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('token') || '';
    if (!t) return false;
    if (safeEq(t, cfg.adminToken)) return true;
    const p = phoneFor(t); if (p) { p.lastSeen = new Date().toISOString(); phones.save(); }
    return !!p;
  };
  // Brute-force guard for pairing codes (matters once ORBIT is on the internet): per address,
  // at most 8 failed attempts per 15 minutes, plus a global cap of 60.
  const fails = new Map(); let globalFails = [];
  const ipOf = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const limited = (req) => {
    const now = Date.now(), cut = now - 15 * 60 * 1000;
    globalFails = globalFails.filter((t) => t > cut);
    const mine = (fails.get(ipOf(req)) || []).filter((t) => t > cut);
    return mine.length >= 8 || globalFails.length >= 60;
  };
  const failed = (req) => { const ip = ipOf(req); fails.set(ip, [...(fails.get(ip) || []), Date.now()]); globalFails.push(Date.now()); };
  const lanUrls = (port) => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${port}`);
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });

  const overview = () => ({
    brain: brain.status(), aiKeys: keyring.list(), home: { name: home.name, simulated: !!home.simulated },
    devices: devices.list(), recent: engine.recent.slice(0, 12), routines: automations.routines(),
    reminders: automations.reminders().filter((r) => !r.done), memoryCount: memory.list().length,
    settings: settings.data, capabilities: CAPABILITIES, memoryKinds: MEMORY_KINDS,
  });

  const routes = {
    'GET /api/overview': () => overview(),
    'POST /api/command': async (b) => {
      const events = [];
      await engine.handle({ text: b.text, sessionId: b.sessionId || 'api', emit: (type, data) => events.push({ type, ...data }) });
      return { events, reply: events.filter((e) => e.type === 'done').map((e) => e.text).join(' ') };
    },
    'GET /api/memory': () => memory.list(),
    'POST /api/memory': (b) => memory.add(b),
    'PATCH /api/memory/:id': (b, id) => memory.update(id, b),
    'DELETE /api/memory/:id': (b, id) => ({ ok: memory.remove(id) }),
    'DELETE /api/memory': () => (memory.clear(), { ok: true }),
    'GET /api/devices': () => devices.list(),
    'POST /api/devices/pairing-code': () => devices.createPairingCode(),
    'PATCH /api/devices/:id': (b, id) => { if (b.name) devices.rename(id, b.name); if (b.permissions) { audit.write({ kind: 'security', action: 'permissions', deviceId: id, permissions: b.permissions }); return devices.setPermissions(id, b.permissions); } return devices.public(devices.get(id)); },
    'POST /api/devices/:id/check': async (b, id) => {
      const d = devices.get(id);
      if (!d || d.revoked) return { ok: false, steps: [{ name: 'Device', ok: false, message: 'Not paired.' }] };
      const steps = [];
      steps.push({ name: 'Connected', ok: devices.sockets.has(id), message: devices.sockets.has(id) ? 'ORBIT is linked to this computer.' : 'Not connected. Make sure ORBIT (or the Companion) is running on it.' });
      if (devices.sockets.has(id)) {
        for (const [cap, params, name] of [['system.status', {}, 'Reads status'], ['notify.show', { title: 'ORBIT', text: 'ORBIT can reach this computer.' }, 'Shows a notification']]) {
          const t0 = performance.now();
          const r = await engine.sendToDevice(d, cap, params);
          steps.push({ name, ok: r.ok, message: r.ok ? `Worked in ${Math.round(performance.now() - t0)} ms.` : r.message });
        }
      }
      const off = Object.entries(CAPABILITIES).filter(([c]) => !d.permissions.includes(c)).map(([, v]) => v.label);
      steps.push({ name: 'Permissions', ok: true, message: off.length ? `Switched off: ${off.join(', ')}. Turn these on under Security if you want ORBIT to do them.` : 'Everything is allowed.' });
      return { ok: steps.every((s) => s.ok), steps };
    },
    'DELETE /api/devices/:id': (b, id) => { audit.write({ kind: 'security', action: 'revoke', deviceId: id }); return { ok: devices.revoke(id) }; },
    'GET /api/automations': () => automations.routines(),
    'POST /api/automations': (b) => automations.upsert(b),
    'DELETE /api/automations/:id': (b, id) => (automations.remove(id), { ok: true }),
    'POST /api/reminders': (b) => automations.addReminder(b),
    'POST /api/reminders/:id/done': (b, id) => automations.completeReminder(id),
    'GET /api/audit': () => audit.tail(100),
    'GET /api/settings': () => settings.data,
    'PATCH /api/settings': (b) => { const allowed = ['userName', 'tone', 'voice', 'wakeWord', 'proactive', 'retentionDays', 'fullControl', 'customInstructions'];
      if ('fullControl' in b) audit.write({ kind: 'security', action: b.fullControl ? 'full control ON' : 'full control off' }); for (const k of allowed) if (k in b) settings.data[k] = b[k]; settingsStore.save(); return settings.data; },
    'GET /api/ai/providers': () => Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, { note: p.note || '', kind: p.kind, extra: p.extra ? { label: p.extra.label, placeholder: p.extra.placeholder } : null, label: p.label, keyHint: p.keyHint, keyOptional: !!p.keyOptional, needsBaseUrl: !!p.needsBaseUrl, baseUrl: p.baseUrl || '', models: p.models, vision: !!p.vision, keysUrl: p.keysUrl || '' }])),
    'GET /api/ai/keys': () => keyring.list(),
    'GET /api/ai/models': () => brain.models(),
    'POST /api/ai/keys': (b) => { const k = keyring.add(b); audit.write({ kind: 'security', action: 'ai key added', provider: k.provider, label: k.label }); brain.warmModels(); return k; },
    'PATCH /api/ai/keys/:id': (b, id) => { const r = keyring.update(id, b); brain.warmModels(); return r; },
    'DELETE /api/ai/keys/:id': (b, id) => { audit.write({ kind: 'security', action: 'ai key removed', id }); return { ok: keyring.remove(id) }; },
    'POST /api/ai/keys/:id/test': async (b, id) => {
      const k = keyring.data.keys.find((x) => x.id === id);
      if (!k) return { ok: false, error: 'Key not found' };
      try {
        if (PROVIDERS[k.provider].kind === 'voice') { const t0 = performance.now(); await testVoiceKey(k.provider, keyring.secretOf(k), k.baseUrl); keyring.markSuccess(k); return { ok: true, ms: Math.round(performance.now() - t0), model: 'voices' }; }
        const r = await brain.test(k); keyring.markSuccess(k); return r;
      }
      catch (e) { keyring.markFailure(k, e); return { ok: false, error: friendly(e, k.provider) }; }
    },
    'POST /api/phone/code': () => {
      const code = String(crypto.randomInt(100000, 999999));
      phones.data.codes = phones.data.codes.filter((c) => c.expiresAt > Date.now());
      phones.data.codes.push({ codeHash: hash(code), expiresAt: Date.now() + 10 * 60 * 1000 }); phones.save();
      return { code, expiresAt: Date.now() + 10 * 60 * 1000, urls: phoneAccess.port ? lanUrls(phoneAccess.port) : [], phoneAccess: !!phoneAccess.port };
    },
    'POST /api/phone/access': async (b) => { const r = await setPhoneAccess(!!b.on); settings.data.phoneAccess = !!b.on; settingsStore.save(); return r; },
    'GET /api/phone/access': () => ({ on: !!phoneAccess.port, port: phoneAccess.port, urls: phoneAccess.port ? lanUrls(phoneAccess.port) : [] }),
    'GET /api/phones': () => phones.data.phones.map(({ id, name, createdAt, lastSeen }) => ({ id, name, createdAt, lastSeen })),
    'DELETE /api/phones/:id': (b, id) => { phones.data.phones = phones.data.phones.filter((p) => p.id !== id); phones.flush(); audit.write({ kind: 'security', action: 'phone removed', id }); return { ok: true }; },
    'PATCH /api/ai/routes': (b) => (keyring.setRoutes(b), brain.status()),
  };

  const handleRequest = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    try {
      if ((url.pathname === '/api/pair' || url.pathname === '/api/phone/pair') && req.method === 'POST' && limited(req)) {
        audit.write({ kind: 'security', action: 'pairing rate-limited', ip: ipOf(req) });
        return json(res, 429, { error: 'Too many wrong codes. Wait 15 minutes and make a new code.' });
      }
      if (url.pathname === '/api/pair' && req.method === 'POST') {
        const r = devices.pair(await readBody(req));
        if (!r) failed(req);
        audit.write({ kind: 'security', action: 'pair', ok: !!r, device: r?.device.name });
        if (r) broadcast('devices', { devices: devices.list() });
        return json(res, r ? 200 : 401, r || { error: 'Invalid or expired pairing code' });
      }
      if (url.pathname === '/api/health') return json(res, 200, { ok: true });
      if (url.pathname === '/api/phone/pair' && req.method === 'POST') {
        const b = await readBody(req);
        const i = phones.data.codes.findIndex((c) => c.expiresAt > Date.now() && safeEq(c.codeHash, hash(String(b.code || ''))));
        if (i < 0) { failed(req); audit.write({ kind: 'security', action: 'phone pairing refused' }); return json(res, 401, { error: 'That code is wrong or has expired. Make a new one on your PC.' }); }
        phones.data.codes.splice(i, 1);
        const token = crypto.randomBytes(32).toString('base64url');
        const phone = { id: crypto.randomUUID(), name: String(b.name || 'Phone').slice(0, 40), tokenHash: hash(token), createdAt: new Date().toISOString(), lastSeen: null };
        phones.data.phones.push(phone); phones.flush();
        audit.write({ kind: 'security', action: 'phone paired', name: phone.name });
        return json(res, 200, { token, name: phone.name });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!isAdmin(req, url)) return json(res, 401, { error: 'Unauthorized' });
        let fn = routes[`${req.method} ${url.pathname}`], id = null;
        if (!fn) for (const [pattern, handler] of Object.entries(routes)) {
          const [method, p] = pattern.split(' ');
          if (method !== req.method || !p.includes(':id')) continue;
          const m = url.pathname.match(new RegExp(`^${p.replace(':id', '([\\w-]+)')}$`));
          if (m) { fn = handler; id = m[1]; break; }
        }
        if (!fn) return json(res, 404, { error: 'Not found' });
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
        try { return json(res, 200, (await fn(body, id)) ?? { ok: false }); }
        catch (e) { return json(res, e.code === 'SENSITIVE' ? 409 : 400, { error: e.message, code: e.code }); }
      }
      // Static dashboard
      const file = path.normalize(path.join(webRoot, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!file.startsWith(webRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
      // Always revalidate the dashboard's files, and stamp script/style addresses with the version,
      // so browsers and CDNs (e.g. Cloudflare) never keep running an old version after an update.
      const ext = path.extname(file);
      const etag = `"${VERSION}"`;
      const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache, must-revalidate', etag, 'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com" };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
      if (ext === '.html' || ext === '.js') { res.writeHead(200, headers); return res.end(stamp(fs.readFileSync(file, 'utf8'), ext)); }
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    } catch (e) { json(res, 500, { error: 'Server error' }); }
  };
  const server = http.createServer(handleRequest);

  // ---- realtime ------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
  const handleUpgrade = (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/ws/ui') {
      if (!isAdmin(req, url)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
      return wss.handleUpgrade(req, socket, head, (ws) => onUi(ws));
    }
    if (url.pathname === '/ws/device') {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const device = devices.authenticate(token);
      if (!device) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
      return wss.handleUpgrade(req, socket, head, (ws) => onDevice(ws, device));
    }
    socket.destroy();
  };
  server.on('upgrade', handleUpgrade);

  // Phone access: a second entrance on the home network, only while switched on.
  const phoneAccess = { server: null, port: 0 };
  async function setPhoneAccess(on, port = 7790) {
    if (phoneAccess.server) { phoneAccess.server.close(); phoneAccess.server = null; phoneAccess.port = 0; }
    if (!on) return { on: false };
    const srv = http.createServer(handleRequest); srv.on('upgrade', handleUpgrade);
    const tryListen = (p) => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(p, '0.0.0.0', () => resolve(srv.address().port)); });
    phoneAccess.port = await tryListen(port).catch(() => tryListen(0));
    phoneAccess.server = srv;
    audit.write({ kind: 'security', action: 'phone access on', port: phoneAccess.port });
    return { on: true, port: phoneAccess.port, urls: lanUrls(phoneAccess.port) };
  }

  function onUi(ws) {
    uiClients.add(ws);
    const sessionId = crypto.randomUUID();
    ws.send(JSON.stringify({ type: 'hello', sessionId, overview: overview() }));
    ws.on('message', async (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      const emit = (type, data) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type, ...data })); };
      if (msg.type === 'approve') engine.agent.resolveApproval(msg.id, msg, sessionId);
      if (msg.type === 'new-session') engine.agent.reset(sessionId);
      if (msg.type === 'utterance') {
        await engine.handle({ text: msg.text, sessionId, source: msg.source, emit, mode: msg.mode === 'code' ? 'code' : 'chat' });
        broadcast('recent', { recent: engine.recent.slice(0, 12) });
      }
      if (msg.type === 'interrupt') engine.cancel(sessionId);
      if (msg.type === 'state') broadcast('core', { state: msg.state }); // listening/idle from the voice engine
    });
    ws.on('close', () => { uiClients.delete(ws); engine.cancel(sessionId); });
  }

  function onDevice(ws, device) {
    const old = devices.sockets.get(device.id); if (old) old.close(4000, 'replaced');
    devices.sockets.set(device.id, ws);
    devices.touch(device.id);
    audit.write({ kind: 'device', device: device.name, action: 'connected' });
    ws.send(JSON.stringify({ type: 'welcome', device: devices.public(device) }));
    broadcast('devices', { devices: devices.list() });
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'result') engine.onDeviceResult(msg);
      if (msg.type === 'status') { devices.touch(device.id, msg.status); broadcast('devices', { devices: devices.list() }); }
    });
    ws.on('close', () => {
      if (devices.sockets.get(device.id) === ws) devices.sockets.delete(device.id);
      broadcast('devices', { devices: devices.list() });
      if (settings.data.proactive.deviceAlerts) broadcast('notify', { level: 'warn', text: `${device.name} went offline.` });
    });
  }

  const heartbeat = setInterval(() => {
    for (const ws of devices.sockets.values()) { if (!ws.isAlive) ws.terminate(); else { ws.isAlive = false; ws.ping(); } }
  }, 20000);
  const reminderTimer = setInterval(() => {
    if (!settings.data.proactive.reminders) return;
    for (const r of automations.due()) { r.fired = true; automations.store.save(); broadcast('notify', { level: 'info', text: `Reminder: ${r.text}`, speak: true, reminderId: r.id }); }
  }, 15000);

  if (settings.data.phoneAccess) setPhoneAccess(true).catch(() => {});
  return {
    setPhoneAccess, server, engine, devices, memory, automations, brain, keyring,
    listen: (port = cfg.port, host = cfg.host) => new Promise((r) => server.listen(port, host, () => r(server.address()))),
    close: () => { if (phoneAccess.server) phoneAccess.server.close(); clearInterval(heartbeat); clearInterval(reminderTimer); for (const c of wss.clients) c.terminate(); return new Promise((r) => server.close(r)); },
  };
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const orbit = createOrbit();
  const addr = await orbit.listen();
  console.log(`\n  ORBIT is online at http://${addr.address}:${addr.port}`);
  console.log(`  AI provider: ${orbit.brain.status().provider}`);
  console.log(`  Dashboard token: ${config.adminToken}\n  (stored in data/admin-token)\n`);
}
