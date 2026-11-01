// Cloud voices with simulated provider responses: request shapes, audio decoding, voice lists and fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLOUD, cloudSpeak, cloudVoices, decodeWav, pcm16ToFloat, testVoiceKey } from '../server/voice/cloud.js';
import { Keyring } from '../server/brain/keyring.js';

const pcm = (n = 2400) => { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * 16000), i * 2); return b; };
const wav = (samples, rate = 48000) => { const d = pcm(samples); const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + d.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(d.length, 40); return Buffer.concat([h, d]); };
function fake(handler) {
  const calls = [];
  const fn = async (url, init = {}) => { calls.push({ url, init, body: init.body && (String(init.body).startsWith('{') ? JSON.parse(init.body) : String(init.body)) }); const r = handler(url, init); return new Response(r.body, { status: r.status || 200 }); };
  fn.calls = calls; return fn;
}

test('audio helpers decode PCM and WAV', () => {
  const f = pcm16ToFloat(new Uint8Array(pcm(100)));
  assert.equal(f.length, 100); assert.ok(Math.abs(f[8] - Math.sin(1) * 16000 / 32768) < 1e-3);
  const w = decodeWav(wav(500, 48000));
  assert.equal(w.sampleRate, 48000); assert.equal(w.samples.length, 500);
});

test('Azure: SSML request to the region endpoint, 24 kHz PCM back', async () => {
  const f = fake(() => ({ body: pcm(2400) }));
  const out = await CLOUD.azure.speak({ key: 'k'.repeat(32), extra: 'eastus', voice: 'en-GB-RyanNeural', text: 'Lights <off> & locked', speed: 1.1, fetchImpl: f });
  const c = f.calls[0];
  assert.equal(c.url, 'https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(c.init.headers['Ocp-Apim-Subscription-Key'], 'k'.repeat(32));
  assert.equal(c.init.headers['X-Microsoft-OutputFormat'], 'raw-24khz-16bit-mono-pcm');
  assert.match(c.body, /<voice name='en-GB-RyanNeural'><prosody rate='\+10%'>Lights &lt;off&gt; &amp; locked<\/prosody>/);
  assert.equal(out.sampleRate, 24000); assert.equal(out.samples.length, 2400);
});

test('Cartesia: lists English voices and speaks with sonic-2', async () => {
  const f = fake((url) => (url.includes('/voices')
    ? { body: JSON.stringify({ data: [{ id: 'v-1', name: 'Calm Butler', language: 'en', description: 'Measured British' }, { id: 'v-2', name: 'French', language: 'fr' }] }) }
    : { body: pcm(1200) }));
  const voices = await CLOUD.cartesia.voices({ key: 'sk_car_x', fetchImpl: f });
  assert.deepEqual(voices.map((v) => v.id), ['v-1']);
  const out = await CLOUD.cartesia.speak({ key: 'sk_car_x', voice: 'v-1', text: 'Good evening.', fetchImpl: f });
  const c = f.calls[1];
  assert.equal(c.url, 'https://api.cartesia.ai/tts/bytes');
  assert.equal(c.init.headers['X-API-Key'], 'sk_car_x');
  assert.ok(c.init.headers['Cartesia-Version']);
  assert.deepEqual(c.body.voice, { mode: 'id', id: 'v-1' });
  assert.equal(c.body.model_id, 'sonic-2');
  assert.deepEqual(c.body.output_format, { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 });
  assert.equal(out.samples.length, 1200);
});

test('Hume: voice library and WAV synthesis with acting instructions', async () => {
  const f = fake((url) => (url.includes('/voices') ? { body: JSON.stringify({ voices_page: [{ id: 'x1', name: 'Ava Song' }] }) } : { body: wav(900, 48000) }));
  assert.deepEqual((await CLOUD.hume.voices({ key: 'h'.repeat(24), fetchImpl: f })).map((v) => v.id), ['Ava Song']);
  const out = await CLOUD.hume.speak({ key: 'h'.repeat(24), voice: 'Ava Song', text: 'Done.', fetchImpl: f });
  const c = f.calls[1];
  assert.equal(c.url, 'https://api.hume.ai/v0/tts/file');
  assert.equal(c.init.headers['X-Hume-Api-Key'], 'h'.repeat(24));
  assert.equal(c.body.utterances[0].voice.name, 'Ava Song');
  assert.match(c.body.utterances[0].description, /calm/i);
  assert.equal(out.sampleRate, 48000); assert.equal(out.samples.length, 900);
});

test('errors are plain and carry the status for fallback', async () => {
  const f = fake(() => ({ status: 402, body: 'quota' }));
  await assert.rejects(CLOUD.cartesia.speak({ key: 'k', voice: 'v', text: 'x', fetchImpl: f }), /Cartesia: the usage limit or free allowance has run out/);
  const g = fake(() => ({ status: 401, body: '' }));
  await assert.rejects(testVoiceKey('azure', 'k', 'eastus', g), /Azure: the key was rejected/);
});

test('keyring: voice keys need their extras and never answer questions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-voice-'));
  const kr = new Keyring(dir);
  assert.throws(() => kr.add({ provider: 'azure', key: 'a'.repeat(32) }), /region/i);
  kr.add({ provider: 'azure', key: 'a'.repeat(32), baseUrl: 'westeurope' });
  kr.add({ provider: 'cartesia', key: 'sk_car_' + 'b'.repeat(24) });
  assert.equal(kr.candidates('fast').length, 0, 'voice keys are not used for answers');
  assert.equal(kr.data.routes.fast.provider, 'anthropic', 'adding a voice key does not change the AI provider');
  assert.throws(() => kr.setRoutes({ fast: { provider: 'hume', model: '' } }), /can't answer questions/);

  const f = fake((url) => (url.includes('cartesia.ai/voices') ? { body: JSON.stringify([{ id: 'v9', name: 'Narrator', language: 'en' }]) } : { body: pcm(480) }));
  const groups = await cloudVoices(kr, f);
  assert.deepEqual(groups.map((g) => [g.provider, !!g.locked]), [['openai', true], ['azure', false], ['cartesia', false], ['hume', true]]);
  assert.equal(groups.find((g) => g.provider === 'cartesia').voices[0].id, 'cartesia:v9');
  assert.equal(groups.find((g) => g.provider === 'azure').voices[0].id, 'azure:en-GB-RyanNeural');
  const audio = await cloudSpeak(kr, 'azure:en-GB-RyanNeural', 'Hello', 1, f);
  assert.equal(audio.samples.length, 480);
  assert.equal(f.calls.at(-1).url, 'https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1', 'stored region is used');
  await assert.rejects(cloudSpeak(kr, 'hume:Ava', 'Hi', 1, f), /No Hume key/);
});
