// On-device speech: wake word, false-wake resistance and transcription, using audio
// synthesized by the app's own local voice. Skipped when the models aren't downloaded (npm run models).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const modelsDir = path.resolve('models');
const { LocalSpeech, modelsPresent, stripWake } = require('../app/speech.js');
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
  const say = (t) => s.synthesize(t).samples;
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
