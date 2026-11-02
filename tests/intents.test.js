import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent } from '../server/intents.js';
import { chooseTier } from '../server/brain/index.js';

const p = (t) => parseIntent(t);

test('device commands parse locally', () => {
  assert.deepEqual(p('Orbit, open Spotify.').params, { app: 'spotify' });
  assert.equal(p('Hey Orbit turn my volume down').params.delta, -15);
  assert.equal(p('orbit set volume to 40 percent').params.level, 40);
  assert.equal(p('Orbit, lock my computer').capability, 'system.lock');
  assert.equal(p('Orbit, take a screenshot').capability, 'screen.capture');
  assert.equal(p('Orbit, why isn\'t this working?').params.analyze, true);
  assert.equal(p('Orbit, open Chrome and search for today\'s news').params.query, "today's news");
  assert.equal(p('open steam on my gaming pc').hint, 'gaming pc');
  assert.equal(p('Orbit, open Spotify and play my music').type, 'chain');
  assert.equal(p('Orbit, send a message to Sam saying running late').capability, 'message.send');
});

test('smart home and routines', () => {
  assert.deepEqual(p('Orbit, switch my lights off'), { type: 'home.lights', on: false, area: null });
  const dim = p('Orbit, set my room lighting to 30 percent');
  assert.equal(dim.brightness, 30); assert.equal(dim.area, 'room');
  assert.equal(p("what's the temperature in my room").area, 'room');
  assert.deepEqual(p('Orbit, activate movie mode'), { type: 'routine', name: 'movie' });
  assert.deepEqual(p('Orbit, start my gaming setup'), { type: 'routine', name: 'gaming' });
  assert.deepEqual(p('Orbit, launch my development environment'), { type: 'routine', name: 'development' });
});

test('local answers, memory, control', () => {
  assert.equal(p('what time is it').type, 'local');
  assert.equal(p('Hey Orbit').type, 'greeting');
  assert.equal(p('remember that my sister is called Maya').text, 'my sister is called Maya');
  assert.equal(p('stop').type, 'stop');
  assert.equal(p('stop listening').type, 'mic.off');
});

test('open-ended questions go to the AI', () => {
  assert.equal(p('Orbit, explain how black holes evaporate'), null);
  assert.equal(chooseTier('what is 2 plus 2'), 'fast');
  assert.equal(chooseTier('explain the tradeoffs of CRDTs vs OT'), 'reasoning');
});

test('speech misspellings snap to command words', async () => {
  const { normalizeSpeech } = await import('../server/intents.js');
  assert.equal(normalizeSpeech('open spotti'), 'open spotify');
  assert.equal(normalizeSpeech('lock my computere'), 'lock my computer');
  assert.equal(normalizeSpeech('open spottify'), 'open spotify');
  assert.equal(normalizeSpeech('tell me a story'), 'tell me a story', 'ordinary words are untouched');
  assert.equal(p('lock my computere').capability, 'system.lock');
});

test('natural phrasing works without an AI', () => {
  assert.deepEqual(p('Orbit, can you open Spotify for me?').params, { app: 'spotify' });
  assert.deepEqual(p('Hey Orbit, could you please open Chrome').params, { app: 'chrome' });
  assert.equal(p('please lock my computer now').capability, 'system.lock');
  assert.equal(p("I'd like you to turn the volume down, thanks").params.delta, -15);
  assert.equal(p('can you turn off the lights').type, 'home.lights');
  assert.equal(p('open spotify orbit').params.app, 'spotify');
  assert.equal(p('can you explain how vaccines work'), null, 'questions still go to the AI');
});

test('more ways to ask for computer status', () => {
  for (const t of ['can you check my computer status for me', "what's my battery level", 'how is my laptop doing', 'how much battery is left', 'show me the system status']) assert.equal(p(t)?.capability, 'system.status', t);
});
