// ORBIT server: dashboard + REST API + realtime WebSocket for the dashboard and Companion agents.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

export function createOrbit(cfg = config) {
  const settingsStore = new JsonStore(cfg.dataDir, 'settings', {
    userName: '', tone: 'composed', voice: { name: '', rate: 1.05, pitch: 0.95 },
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
  const home = createHome(cfg);
  const automations = new Automations(cfg.dataDir);
  const engine = new Engine({ brain, memory, devices, home, automations, audit, settings });
  const uiClients = new Set();
  const broadcast = (type, data) => { const m = JSON.stringify({ type, ...data }); for (const c of uiClients) if (c.readyState === 1) c.send(m); };

  const webRoot = path.join(cfg.root, 'web');
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
  const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const isAdmin = (req, url) => {
    const t = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('token') || '';
    return t && safeEq(t, cfg.adminToken);
  };
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
    'PATCH /api/settings': (b) => { const allowed = ['userName', 'tone', 'voice', 'wakeWord', 'proactive', 'retentionDays']; for (const k of allowed) if (k in b) settings.data[k] = b[k]; settingsStore.save(); return settings.data; },
    'GET /api/ai/providers': () => Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, { kind: p.kind, extra: p.extra ? { label: p.extra.label, placeholder: p.extra.placeholder } : null, label: p.label, keyHint: p.keyHint, keyOptional: !!p.keyOptional, needsBaseUrl: !!p.needsBaseUrl, baseUrl: p.baseUrl || '', models: p.models, vision: !!p.vision, keysUrl: p.keysUrl || '' }])),
    'GET /api/ai/keys': () => keyring.list(),
    'GET /api/ai/models': () => brain.models(),
    'POST /api/ai/keys': (b) => { const k = keyring.add(b); audit.write({ kind: 'security', action: 'ai key added', provider: k.provider, label: k.label }); return k; },
    'PATCH /api/ai/keys/:id': (b, id) => keyring.update(id, b),
    'DELETE /api/ai/keys/:id': (b, id) => { audit.write({ kind: 'security', action: 'ai key removed', id }); return { ok: keyring.remove(id) }; },
    'POST /api/ai/keys/:id/test': async (b, id) => {
      const k = keyring.data.keys.find((x) => x.id === id);
      if (!k) return { ok: false, error: 'Key not found' };
      try {
        if (PROVIDERS[k.provider].kind === 'voice') { const t0 = performance.now(); await testVoiceKey(k.provider, keyring.secretOf(k), k.baseUrl); keyring.markSuccess(k); return { ok: true, ms: Math.round(performance.now() - t0), model: 'voices' }; }
        const r = await brain.test(k); keyring.markSuccess(k); return r;
      }
      catch (e) { keyring.markFailure(k, e); return { ok: false, error: friendly(e) }; }
    },
    'PATCH /api/ai/routes': (b) => (keyring.setRoutes(b), brain.status()),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    try {
      if (url.pathname === '/api/pair' && req.method === 'POST') {
        const r = devices.pair(await readBody(req));
        audit.write({ kind: 'security', action: 'pair', ok: !!r, device: r?.device.name });
        if (r) broadcast('devices', { devices: devices.list() });
        return json(res, r ? 200 : 401, r || { error: 'Invalid or expired pairing code' });
      }
      if (url.pathname === '/api/health') return json(res, 200, { ok: true });
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
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com" });
      fs.createReadStream(file).pipe(res);
    } catch (e) { json(res, 500, { error: 'Server error' }); }
  });

  // ---- realtime ------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
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
  });

  function onUi(ws) {
    uiClients.add(ws);
    const sessionId = crypto.randomUUID();
    ws.send(JSON.stringify({ type: 'hello', sessionId, overview: overview() }));
    ws.on('message', async (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      const emit = (type, data) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type, ...data })); };
      if (msg.type === 'utterance') {
        await engine.handle({ text: msg.text, sessionId, source: msg.source, emit });
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

  return {
    server, engine, devices, memory, automations, brain, keyring,
    listen: (port = cfg.port, host = cfg.host) => new Promise((r) => server.listen(port, host, () => r(server.address()))),
    close: () => { clearInterval(heartbeat); clearInterval(reminderTimer); for (const c of wss.clients) c.terminate(); return new Promise((r) => server.close(r)); },
  };
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const orbit = createOrbit();
  const addr = await orbit.listen();
  console.log(`\n  ORBIT is online at http://${addr.address}:${addr.port}`);
  console.log(`  AI provider: ${orbit.brain.status().provider}`);
  console.log(`  Dashboard token: ${config.adminToken}\n  (stored in data/admin-token)\n`);
}
