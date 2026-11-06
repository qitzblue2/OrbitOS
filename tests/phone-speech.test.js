// A phone talking to ORBIT's speech engine on the server, over the live connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { modelsPresent, LocalSpeech, resample } = require('../app/speech.js');
const ready = modelsPresent(path.resolve('models'));

test('phone voice: wake word, transcript and ORBIT\'s voice come from the server', { skip: !ready && 'models not downloaded' }, async () => {
  process.env.ORBIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-phone-'));
  process.env.ORBIT_ENV_FILE = path.join(process.env.ORBIT_DATA_DIR, '.env');
  const { config } = await import('../server/config.js');
  const { createOrbit } = await import('../server/index.js');
  const orbit = createOrbit(config);
  const { port } = await orbit.listen(0, '127.0.0.1');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ui?token=${config.adminToken}`);
  const got = [];
  const waitFor = (pred, ms = 30000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`timeout; got ${JSON.stringify(got.map((m) => m.ev || m.type))}`)), ms); const iv = setInterval(() => { const m = got.find(pred); if (m) { clearTimeout(t); clearInterval(iv); res(m); } }, 50); });
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'speech' || m.type === 'speech-tts') got.push(m); });
  await new Promise((r) => ws.on('open', r));
  try {
    ws.send(JSON.stringify({ type: 'speech-boot' }));
    await waitFor((m) => m.ev === 'ready');
    ws.send(JSON.stringify({ type: 'speech-listen', on: true }));
    const tts = new LocalSpeech(path.resolve('models'));
    const say = (t) => { const a = tts.synthesize(t); return resample(a.samples, a.sampleRate); };
    const audio = Float32Array.from([...new Float32Array(9600), ...say('Hey Orbit.'), ...new Float32Array(3200), ...say('What time is it?'), ...new Float32Array(32000)]);
    for (let i = 0; i < audio.length; i += 1600) ws.send(Buffer.from(audio.slice(i, i + 1600).buffer));
    await waitFor((m) => m.ev === 'wake');
    const utt = await waitFor((m) => m.ev === 'utterance');
    assert.match(utt.data, /time/);
    ws.send(JSON.stringify({ type: 'speech-say', id: 'r1', text: "It's noon." }));
    const voice = await waitFor((m) => m.type === 'speech-tts' && m.id === 'r1');
    assert.ok(voice.sampleRate >= 22050 && voice.pcm.length > 1000, 'ORBIT voice audio returned');
  } finally { ws.close(); await orbit.close(); }
});
