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
process.env.ORBIT_ENV_FILE = path.join(process.env.ORBIT_DATA_DIR, '.env');
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

test('AI fallback is honest when no key is configured', async () => {
  assert.match((await say('explain quantum tunnelling')).reply, /add an AI key under AI configuration/);
});

test('revoking a device disconnects it and kills its token', async () => {
  const closed = new Promise((r) => deviceWs.on('close', (code) => r(code)));
  await api('DELETE', `/api/devices/${device.device.id}`);
  assert.equal(await closed, 4001);
  const retry = new WebSocket(`ws://127.0.0.1:${port}/ws/device`, { headers: { authorization: `Bearer ${device.token}` } });
  const status = await new Promise((r) => { retry.on('unexpected-response', (_, res) => r(res.statusCode)); retry.on('open', () => r(200)); });
  assert.equal(status, 401);
});

test('unlimited keys: encrypted, never returned, validated', async () => {
  const k1 = 'sk-ant-test-' + 'a'.repeat(30), k2 = 'sk-ant-test-' + 'b'.repeat(30), k3 = 'gsk_' + 'c'.repeat(30);
  assert.equal((await api('POST', '/api/ai/keys', { provider: 'openai', key: 'nope' })).status, 400, 'format checked');
  for (const [provider, key] of [['anthropic', k1], ['anthropic', k2], ['groq', k3]]) assert.equal((await api('POST', '/api/ai/keys', { provider, key })).status, 200);
  assert.equal((await api('POST', '/api/ai/keys', { provider: 'anthropic', key: k1 })).status, 400, 'duplicates refused');
  assert.equal((await api('POST', '/api/ai/keys', { provider: 'ollama' })).status, 200, 'local models need no key');
  const listed = (await api('GET', '/api/ai/keys')).body;
  assert.equal(listed.length, 4);
  const everything = JSON.stringify((await api('GET', '/api/overview')).body) + JSON.stringify(listed) + fs.readFileSync(path.join(config.dataDir, 'keys.json'), 'utf8');
  for (const k of [k1, k2, k3]) assert.ok(!everything.includes(k), 'raw key never exposed or stored in plain text');
  assert.equal(listed[0].last4, 'aaaa');
  assert.equal((await api('GET', '/api/overview')).body.brain.routes.fast.provider, 'anthropic', 'first key decides the active provider');
});

test('failover: a dead key hands over to the next key and provider', async () => {
  const { keyring, brain } = orbit;
  // Simulate providers: the first Anthropic key is rate-limited, the second works.
  const seen = [];
  brain.client = (key) => ({ async *stream() {
    seen.push(key.label);
    if (key.last4 === 'aaaa') { const e = new Error('rate limited'); e.status = 429; throw e; }
    yield 'Hello from '; yield key.provider;
  } });
  keyring.setRoutes({ fast: { provider: 'anthropic', model: '' }, fallback: true });
  let text = '', meta;
  for (let i = 0; i < 2; i++) { text = ''; for await (const p of brain.answer({ text: 'hi' })) { if (p.meta) meta = p.meta; else text += p.delta; } }
  assert.equal(text, 'Hello from anthropic');
  assert.ok(keyring.list().find((k) => k.last4 === 'aaaa').coolingDown, 'rate-limited key is cooled down');
  // All Anthropic keys disabled: falls back to another provider.
  for (const k of keyring.list().filter((k) => k.provider === 'anthropic')) keyring.update(k.id, { enabled: false });
  text = ''; for await (const p of brain.answer({ text: 'hi' })) { if (p.meta) meta = p.meta; else text += p.delta; }
  assert.notEqual(meta.provider, 'anthropic');
  assert.match(text, /Hello from (groq|ollama)/);
  // Routes are changeable per tier.
  const st = (await api('PATCH', '/api/ai/routes', { reasoning: { provider: 'groq', model: 'llama-3.3-70b-versatile' } })).body;
  assert.equal(st.reasoningModel, 'llama-3.3-70b-versatile');
});

test('choose the AI model: live lists, menu switch and voice command', async () => {
  const { brain } = orbit;
  brain.models = async () => ({ openai: { label: 'OpenAI', source: 'live', models: ['gpt-4o', 'gpt-4o-mini', 'o3'] }, groq: { label: 'Groq', source: 'live', models: ['llama-3.3-70b-versatile'] } });
  const lists = (await api('GET', '/api/ai/models')).body;
  assert.deepEqual(lists.openai.models, ['gpt-4o', 'gpt-4o-mini', 'o3']);
  // Voice command switches both tiers
  const r = await say('Orbit, switch to gpt four o mini');
  assert.equal(r.reply, 'Switched to gpt-4o-mini.');
  assert.ok(r.events.some((e) => e.type === 'model'), 'dashboard told about the change');
  let st = (await api('GET', '/api/overview')).body.brain;
  assert.equal(st.fastModel, 'gpt-4o-mini'); assert.equal(st.reasoningModel, 'gpt-4o-mini');
  assert.match((await say('which model are you using')).reply, /gpt-4o-mini/);
  assert.match((await say('use banana phone')).reply, /couldn't find a model/);
  // Per-tier choice from the menu
  st = (await api('PATCH', '/api/ai/routes', { fast: { provider: 'groq', model: 'llama-3.3-70b-versatile' }, reasoning: { provider: 'openai', model: 'o3' } })).body;
  assert.equal(st.fastModel, 'llama-3.3-70b-versatile'); assert.equal(st.reasoningModel, 'o3');
});

test('loosely worded requests are mapped to commands by the AI, with the same checks', async () => {
  const { brain } = orbit;
  const realRoute = brain.route.bind(brain);
  const asked = [];
  brain.status = (() => { const st = brain.status.bind(brain); return () => ({ ...st(), provider: 'openai' }); })();
  brain.answer = async function* ({ system, text }) { asked.push(text); yield { meta: {} }; yield { delta: /music/.test(text) ? 'play music' : /quieter/.test(text) ? 'turn the volume down' : 'NONE' }; };
  // A command the device isn't allowed to run is still refused after routing
  const music = await say('put some music on');
  assert.ok(music.events.some((e) => e.type === 'routed' && e.to === 'play music'), 'mapped to a command');
  assert.match(music.reply, /isn't allowed|online|No devices|Playing|reported/, 'and still goes through device checks');
  const r = await say('make it a bit quieter in here');
  assert.ok(r.events.some((e) => e.type === 'routed' && e.to === 'turn the volume down'));
  assert.equal(await realRoute('what is the capital of france'), null, 'questions are not commands');
});

test('Poe works as an OpenAI-compatible provider with bot names as models', async () => {
  const { PROVIDERS, SUGGESTED } = await import('../server/brain/catalog.js');
  assert.equal(PROVIDERS.poe.baseUrl, 'https://api.poe.com/v1');
  assert.equal(PROVIDERS.poe.kind, 'openai');
  assert.ok(SUGGESTED.poe.includes('Claude-Sonnet-4'));
  const added = await api('POST', '/api/ai/keys', { provider: 'poe', key: 'poe_' + 'k'.repeat(30) });
  assert.equal(added.status, 200);
  assert.equal(added.body.baseUrl, 'https://api.poe.com/v1');
  const st = (await api('PATCH', '/api/ai/routes', { fast: { provider: 'poe', model: 'GPT-4o' } })).body;
  assert.equal(st.fastModel, 'GPT-4o');
});
