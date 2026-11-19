import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

process.env.ORBIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-feat-'));
process.env.ORBIT_AI_PROVIDER = 'offline';
process.env.ANTHROPIC_API_KEY = '';
process.env.ORBIT_ENV_FILE = path.join(process.env.ORBIT_DATA_DIR, '.env');
const { config } = await import('../server/config.js');
const { createOrbit } = await import('../server/index.js');
const { parseIntent } = await import('../server/intents.js');
const { isQuiet, weatherCard, weatherSentence, healthSentence, hostHealth } = await import('../server/features.js');
const { VoiceId } = await import('../server/voiceid.js');
const { Spotify } = await import('../server/spotify.js');

const orbit = createOrbit(config);
const { port } = await orbit.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json' };
const api = async (method, p, body) => (await fetch(base + p, { method, headers: auth, body: body && JSON.stringify(body) })).json();
const sockets = [];
test.after(async () => { sockets.forEach((s) => s.terminate()); await orbit.close(); });

function client(room) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ui?token=${config.adminToken}`); sockets.push(ws);
    const got = [];
    ws.on('message', (d) => got.push(JSON.parse(d)));
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'client-info', room, voice: true })); setTimeout(() => resolve({ ws, got }), 100); });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('new spoken commands are understood locally', () => {
  const cases = {
    "what's the weather": 'weather', 'show me the weather this week': 'weather', "how's the pi doing": 'health',
    'what am i holding': 'camera.look', 'tell the bedroom dinner is ready': 'intercom', 'announce dinner is ready': 'intercom',
    'pair a new speaker': 'bt', 'connect the speaker': 'bt', 'use the pi speaker': 'bt', 'play my liked songs': 'spotify',
    'play daft punk on spotify': 'spotify', 'learn my voice': 'voiceid.enroll', 'show my to-do list': 'reminders.show',
    'set my location to Amsterdam': 'location.set',
  };
  for (const [said, type] of Object.entries(cases)) assert.equal(parseIntent(said)?.type, type, said);
  assert.equal(parseIntent('tell me a joke'), null);
  assert.equal(parseIntent('play music').type, 'chain', 'existing commands still work');
});

test('quiet hours wrap around midnight', () => {
  const q = { enabled: true, start: '22:30', end: '07:00' };
  const at = (h, m = 0) => new Date(2026, 0, 1, h, m);
  assert.ok(isQuiet(q, at(23)) && isQuiet(q, at(3)) && isQuiet(q, at(22, 30)));
  assert.ok(!isQuiet(q, at(7)) && !isQuiet(q, at(12)) && !isQuiet({ ...q, enabled: false }, at(23)));
});

test('weather and health text', async () => {
  const w = { place: 'Amsterdam, Netherlands', now: { temp: 8, text: 'cloudy', wind: 20 }, days: [{ date: '2026-11-20', text: 'light rain', max: 10, min: 4, rain: 70 }, { date: '2026-11-21', text: 'clear', max: 9, min: 2, rain: 0 }] };
  assert.match(weatherSentence(w), /8 degrees and cloudy in Amsterdam.*70 percent chance of rain/);
  assert.match(weatherCard(w), /^# Weather in Amsterdam[\s\S]*- Friday: light rain/);
  const h = await hostHealth();
  assert.ok(h.memoryUsed >= 0 && h.load >= 0);
  assert.match(healthSentence({ ...h, temperature: 82, throttled: true }), /too hot.*slowing itself down/);
});

test('voice ID tells the owner from someone else', () => {
  const v = new VoiceId(fs.mkdtempSync(path.join(os.tmpdir(), 'vid-')));
  const me = (n) => Array.from({ length: 8 }, (_, i) => (i < 4 ? 1 : 0) + n * 0.05 * (i % 2 ? 1 : -1));
  v.startEnroll('s');
  assert.deepEqual(v.addSample('s', me(1)), { done: false, left: 2 });
  assert.equal(v.addSample('s', null).error, true);
  v.addSample('s', me(2)); assert.equal(v.addSample('s', me(3)).done, true);
  assert.equal(v.matches(me(4)), true);
  assert.equal(v.matches([0, 0, 0, 0, 1, 1, 1, 1]), false);
  assert.equal(v.matches(null), null, 'no fingerprint: cannot tell');
});

test('Spotify sign-in link and playback calls', async () => {
  const calls = [];
  const fake = async (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${url.replace('https://api.spotify.com/v1', '')}`);
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (url.includes('/api/token')) return ok({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
    if (url.endsWith('/me')) return ok({ display_name: 'Tester' });
    if (url.includes('/search')) return ok({ tracks: { items: [{ type: 'track', uri: 'spotify:track:1', name: 'One More Time', artists: [{ name: 'Daft Punk' }] }] }, artists: { items: [] }, playlists: { items: [] } });
    if (url.includes('/me/player/devices')) return ok({ devices: [{ id: 'd1', name: 'Desk speaker', is_active: true }] });
    return { ok: true, status: 204, json: async () => null };
  };
  const sp = new Spotify(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-')), fake);
  assert.throws(() => sp.start('nope'));
  const { url } = sp.start('0123456789abcdef0123456789abcdef');
  const state = new URL(url).searchParams.get('state');
  assert.match(url, /code_challenge_method=S256/);
  await sp.finish(`http://127.0.0.1:7777/spotify?code=abc&state=${state}`);
  assert.equal(sp.status().user, 'Tester');
  const r = await sp.play({ query: 'daft punk' });
  assert.equal(r.say, 'Playing One More Time by Daft Punk.');
  assert.ok(calls.includes('PUT /me/player/play?device_id=d1'));
});

test('intercom delivers to the named room only', async () => {
  const bed = await client('Bedroom'), desk = await client('Desk'), kitchen = await client('Kitchen');
  desk.ws.send(JSON.stringify({ type: 'utterance', text: "tell the bedroom dinner's ready", source: 'text' }));
  await wait(300);
  assert.equal(bed.got.find((m) => m.type === 'announce')?.text, "dinner's ready");
  assert.equal(bed.got.find((m) => m.type === 'announce')?.from, 'Desk');
  assert.ok(!kitchen.got.some((m) => m.type === 'announce'));
  assert.match(desk.got.find((m) => m.type === 'done').text, /Told the bedroom/);
  [bed, desk, kitchen].forEach((c) => c.ws.terminate());
  await wait(100);
});

test('when two devices hear the same sentence only one answers', async () => {
  const a = await client('Desk'), b = await client('Bedroom');
  for (const c of [a, b]) c.ws.send(JSON.stringify({ type: 'utterance', text: 'what time is it', source: 'voice' }));
  await wait(900);
  const answers = [a, b].map((c) => c.got.filter((m) => m.type === 'done'));
  const real = answers.flat().filter((m) => !m.answeredElsewhere);
  assert.equal(real.length, 1, 'exactly one device answers');
  assert.match(real[0].text, /^It's /);
  assert.equal(answers.flat().filter((m) => m.answeredElsewhere).length, 1);
});

test('settings: quiet hours saved, ambient info served', async () => {
  const s = await api('PATCH', '/api/settings', { quietHours: { enabled: true, start: '00:00', end: '23:59' } });
  assert.equal(s.quietHours.enabled, true);
  const amb = await api('GET', '/api/ambient');
  assert.equal(amb.quiet, true);
  const r = await api('POST', '/api/command', { text: 'what time is it' });
  assert.equal(r.events.find((e) => e.type === 'done').quiet, true, 'replies are marked quiet at night');
  await api('PATCH', '/api/settings', { quietHours: { enabled: false, start: '22:30', end: '07:00' } });
});
