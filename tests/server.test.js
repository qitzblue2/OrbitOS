import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

process.env.ORBIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-test-'));
process.env.ORBIT_AI_PROVIDER = 'offline';
process.env.ANTHROPIC_API_KEY = '';
process.env.ORBIT_DEVICE_TIMEOUT_MS = '400';
const { config } = await import('../server/config.js');
const { createOrbit } = await import('../server/index.js');
const { looksSensitive } = await import('../server/memory.js');

const orbit = createOrbit(config);
const { port } = await orbit.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json' };
const api = async (method, p, body) => { const r = await fetch(base + p, { method, headers: auth, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const say = async (text, sessionId = 't') => (await api('POST', '/api/command', { text, sessionId })).body;

let device, deviceWs, received = [], mode = 'ok';
test.after(async () => { deviceWs?.terminate(); await orbit.close(); });

test('API requires the admin token', async () => {
  const r = await fetch(`${base}/api/overview`);
  assert.equal(r.status, 401);
});

test('pairing issues a device credential once', async () => {
  const { body: { code } } = await api('POST', '/api/devices/pairing-code');
  const pair = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Test PC', platform: 'windows' }) });
  assert.equal(pair.status, 200);
  device = await pair.json();
  const again = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'x' }) });
  assert.equal(again.status, 401, 'code is single use');
  const stored = fs.readFileSync(path.join(config.dataDir, 'devices.json'), 'utf8');
  assert.ok(!stored.includes(device.token), 'token is stored hashed');
});

test('no device online: ORBIT says so instead of pretending', async () => {
  const r = await say('open spotify');
  assert.match(r.reply, /online/);
});

test('device executes and acknowledges', async () => {
  deviceWs = new WebSocket(`ws://127.0.0.1:${port}/ws/device`, { headers: { authorization: `Bearer ${device.token}` } });
  deviceWs.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== 'command') return;
    received.push(m);
    if (mode === 'ok') deviceWs.send(JSON.stringify({ type: 'result', id: m.id, ok: true, message: 'done' }));
    if (mode === 'fail') deviceWs.send(JSON.stringify({ type: 'result', id: m.id, ok: false, message: 'Spotify is not installed.' }));
    // mode 'silent': never answer
  });
  await new Promise((r) => deviceWs.on('open', r));
  await new Promise((r) => setTimeout(r, 50));
  const r = await say('Orbit, open Spotify');
  assert.equal(received.at(-1).capability, 'app.open');
  assert.equal(r.reply, 'Opening spotify.');
});

test('failure and silence are reported honestly', async () => {
  mode = 'fail';
  assert.match((await say('open spotify')).reply, /not installed/);
  mode = 'silent';
  assert.match((await say('open spotify')).reply, /can't say it worked/);
  mode = 'ok';
});

test('permissions are enforced server-side', async () => {
  const r = await say('lock my computer');
  assert.match(r.reply, /isn't allowed/);
  await api('PATCH', `/api/devices/${device.device.id}`, { permissions: ['app.open', 'system.lock', 'message.send'] });
  assert.equal((await say('lock my computer')).reply, 'Locked.');
});

test('sensitive actions wait for confirmation', async () => {
  const before = received.length;
  const ask = await say('send a message to Sam saying running late', 's2');
  assert.match(ask.reply, /Say yes to confirm/);
  assert.equal(received.length, before, 'nothing sent before confirmation');
  await say('yes', 's2');
  assert.equal(received.at(-1).capability, 'message.send');
});

test('routines run through the same pipeline', async () => {
  const r = await say('activate movie mode');
  assert.match(r.reply, /Movie mode/);
  const lights = r.events.find((e) => e.type === 'action' && e.step?.includes('lights'));
  assert.equal(lights.status, 'ok');
});

test('memory: add, recall, sensitive guard, delete', async () => {
  assert.match((await say('remember that my sister is called Maya')).reply, /remember/);
  assert.equal((await api('POST', '/api/memory', { text: 'my bank password is hunter2' })).status, 409);
  assert.ok(looksSensitive('card 4111111111111111'));
  const list = (await api('GET', '/api/memory')).body;
  assert.equal(list.length, 1);
  assert.equal((await api('DELETE', `/api/memory/${list[0].id}`)).body.ok, true);
});

test('AI fallback is honest when no model is configured', async () => {
  assert.match((await say('explain quantum tunnelling')).reply, /isn't connected/);
});

test('revoking a device disconnects it and kills its token', async () => {
  const closed = new Promise((r) => deviceWs.on('close', (code) => r(code)));
  await api('DELETE', `/api/devices/${device.device.id}`);
  assert.equal(await closed, 4001);
  const retry = new WebSocket(`ws://127.0.0.1:${port}/ws/device`, { headers: { authorization: `Bearer ${device.token}` } });
  const status = await new Promise((r) => { retry.on('unexpected-response', (_, res) => r(res.statusCode)); retry.on('open', () => r(200)); });
  assert.equal(status, 401);
});
