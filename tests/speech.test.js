// On-device speech: wake word, false-wake resistance and transcription, using audio
// synthesized by the app's own local voice. Skipped when the models aren't downloaded (npm run models).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const modelsDir = path.resolve('models');
const { LocalSpeech, modelsPresent, stripWake, resample } = require('../app/speech.js');
const ready = fs.existsSync(modelsDir) && modelsPresent(modelsDir);

test('wake phrase is removed from the transcript', () => {
  assert.equal(stripWake('hey orbit open spotify'), 'open spotify');
  assert.equal(stripWake('a orbit what time is it'), 'what time is it');
  assert.equal(stripWake('turn off the lights'), 'turn off the lights');
});

test('wake word and local speech recognition', { skip: !ready && 'models not downloaded' }, () => {
  const s = new LocalSpeech(modelsDir);
  const z = (sec) => new Float32Array(16000 * sec);
  const feed = (x) => { for (let i = 0; i < x.length; i += 1600) s.accept(x.subarray(i, i + 1600)); };
  // Voices speak at 22–24 kHz; the recognizer listens at 16 kHz, like a real microphone stream.
  const say = (t) => { const a = s.synthesize(t); return resample(a.samples, a.sampleRate); };
  let wakes = 0, heard = [];
  s.on('wake', () => wakes++);
  s.on('utterance', (t) => heard.push(t));

  for (const cmd of ['Turn off all the lights.', 'What time is it?', 'Lock my computer.']) {
    feed(z(0.6)); feed(say('Hey Orbit.')); feed(z(0.2)); feed(say(cmd)); feed(z(1.6)); s.cancel();
  }
  assert.ok(wakes >= 2, `woke ${wakes}/3 times`);
  assert.ok(heard.some((t) => t.includes('lights')), JSON.stringify(heard));

  const before = wakes;
  for (const t of ['The satellite stays in a low orbit.', 'Hey Robert, are you coming?', 'A bit of rain is expected.']) { feed(z(0.6)); feed(say(t)); feed(z(1.2)); s.cancel(); }
  assert.equal(wakes, before, 'no false wakes on near-miss phrases');
});

test('voices: switch, fall back when missing, and speak smoothly', { skip: !ready && 'models not downloaded' }, () => {
  const s = new LocalSpeech(modelsDir, { voice: 'lessac' });
  assert.equal(s.voice, 'lessac');
  const a = s.synthesize('Good evening.');
  assert.ok(a.sampleRate >= 22050, `smooth voices run at 22 kHz or more (got ${a.sampleRate})`);
  assert.equal(s.setVoice('kokoro:not-downloaded'), 'alan', 'missing voice falls back to the built-in one');
  assert.ok(s.benchmark() < 1, 'built-in voice is faster than real time');
});

test('the spoken command audio is kept for optional cloud transcription', { skip: !ready && 'models not downloaded' }, () => {
  const s = new LocalSpeech(modelsDir);
  const z = (sec) => new Float32Array(16000 * sec);
  const say = (t) => { const a = s.synthesize(t); return resample(a.samples, a.sampleRate); };
  const feed = (x) => { for (let i = 0; i < x.length; i += 1600) s.accept(x.subarray(i, i + 1600)); };
  let got = null;
  s.on('utterance', (text, audio) => { got = { text, audio }; });
  const cmd = say('What time is it?');
  feed(z(0.6)); feed(say('Hey Orbit.')); feed(z(0.2)); feed(cmd); feed(z(1.6));
  assert.ok(got, 'utterance emitted');
  assert.ok(got.audio.length > cmd.length, 'audio covers the whole command, including the moment after the wake word');
  assert.ok(got.audio.length < 16000 * 30, 'capped at 30 seconds');
});

// Runs the browser AudioWorklet in Node with a tiny shim, to test the automatic volume boost.
async function loadWorklet() {
  let Proc;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => this.out.push(m), onmessage: null }; this.out = []; } };
  globalThis.registerProcessor = (_n, cls) => { Proc = cls; };
  await import(`../web/pcm-worklet.js?${Date.now()}`);
  return () => new Proc();
}
function runWorklet(proc, signal) {
  for (let i = 0; i < signal.length; i += 128) proc.process([[signal.subarray(i, i + 128)]]);
  return proc.out;
}

test('volume boost: quiet voices are raised, loud ones are not clipped', async () => {
  const make = await loadWorklet();
  // Words of 0.8 s separated by 0.4 s gaps with faint room noise, like real speech.
  const speechLike = (amp, sec = 4) => Float32Array.from({ length: 16000 * sec }, (_, i) => (i % 19200 < 12800 ? amp * Math.sin(i / 7) * (0.6 + 0.4 * Math.sin(i / 3000)) : 0) + (Math.random() - 0.5) * 0.001);
  const quiet = runWorklet(make(), speechLike(0.008));
  assert.ok(quiet.at(-1).gain > 5, `quiet voice boosted (${quiet.at(-1).gain.toFixed(1)}x)`);
  const loud = runWorklet(make(), speechLike(0.7));
  assert.ok(loud.at(-1).gain < 1.2, 'loud voice not boosted');
  assert.ok(loud.every((m) => m.samples.every((v) => Math.abs(v) <= 1)), 'never clips');
  const p = make(); p.port.onmessage({ data: { boost: 4 } });
  assert.ok(Math.abs(runWorklet(p, speechLike(0.05)).at(-1).gain - 4) < 0.1, 'manual boost honoured');
});

test('quiet speech: boosting rescues wake words that would be missed', { skip: !ready && 'models not downloaded' }, async () => {
  const make = await loadWorklet();
  const s = new LocalSpeech(modelsDir);
  const z = (sec) => new Float32Array(16000 * sec);
  const say = (t, amp) => { const a = s.synthesize(t); const x = resample(a.samples, a.sampleRate); let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v)); return x.map((v) => (v / peak) * amp); };
  const trial = (boosted, amp) => {
    const eng = new LocalSpeech(modelsDir); let wakes = 0; eng.on('wake', () => wakes++);
    const proc = make();
    for (let k = 0; k < 4; k++) {
      const sig = Float32Array.from([...z(1), ...say(k % 2 ? 'Hey Orbit.' : 'Hi Orbit.', amp), ...z(0.3), ...say('Lock my computer.', amp), ...z(1.8)]);
      if (boosted) for (const m of runWorklet(proc, sig)) eng.accept(m.samples); else for (let i = 0; i < sig.length; i += 1600) eng.accept(sig.subarray(i, i + 1600));
      eng.cancel();
    }
    return wakes;
  };
  const amp = 0.02; // a quiet voice from across the room
  const before = trial(false, amp), after = trial(true, amp);
  assert.ok(after >= 3, `with boost: woke ${after}/4 (without: ${before}/4)`);
  assert.ok(after >= before);
});
