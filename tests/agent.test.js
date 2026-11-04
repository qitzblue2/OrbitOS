// The ORBIT agent against a simulated computer and a scripted AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

process.env.ORBIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agent-'));
process.env.ORBIT_AI_PROVIDER = 'offline';
process.env.ANTHROPIC_API_KEY = '';
process.env.ORBIT_ENV_FILE = path.join(process.env.ORBIT_DATA_DIR, '.env');
const { config } = await import('../server/config.js');
const { createOrbit } = await import('../server/index.js');
const { _test, complete } = await import('../server/brain/tools.js');

const orbit = createOrbit(config);
const { port } = await orbit.listen(0, '127.0.0.1');
const { code } = orbit.devices.createPairingCode();
const paired = orbit.devices.pair({ code, name: 'Test PC', platform: 'windows' });
orbit.devices.setPermissions(paired.device.id, ['app.open', 'files.read', 'files.write', 'shell.run', 'system.status']);
orbit.keyring.add({ provider: 'openai', key: 'sk-test' + 'x'.repeat(30) });

// Simulated computer: records what it was asked to do.
const done = [];
const pc = new WebSocket(`ws://127.0.0.1:${port}/ws/device`, { headers: { authorization: `Bearer ${paired.token}` } });
pc.on('message', (raw) => {
  const m = JSON.parse(raw); if (m.type !== 'command') return;
  done.push({ cap: m.capability, params: m.params });
  const data = m.capability === 'shell.run' ? { exitCode: 0, output: 'v22.0.0' } : m.capability === 'files.read' ? { content: '<h1>Hi</h1>' } : {};
  pc.send(JSON.stringify({ type: 'result', id: m.id, ok: true, message: 'ok', data }));
});
await new Promise((r) => pc.on('open', r));
await new Promise((r) => setTimeout(r, 50));
test.after(async () => { pc.terminate(); await orbit.close(); });

// Scripted AI: plays back tool calls, then a final answer.
function script(steps) {
  let i = 0; const seen = [];
  orbit.brain.step = async ({ messages }) => { seen.push(messages.at(-1)); return steps[Math.min(i++, steps.length - 1)]; };
  return seen;
}
const call = (name, args) => ({ id: `c_${Math.random().toString(36).slice(2)}`, name, args });

async function run(text, { approve = 'yes', mode = 'chat' } = {}) {
  const events = [];
  const emit = (type, data) => {
    events.push({ type, ...data });
    if (type === 'approve' && approve !== 'none') setTimeout(() => orbit.engine.agent.resolveApproval(data.id, { ok: approve !== 'no', session: approve === 'session' }, 'sess'), 5);
  };
  await orbit.engine.handle({ text, sessionId: 'sess', emit, mode });
  return events;
}

test('"create me a website": writes the file after approval, opens it, reports back', async () => {
  done.length = 0;
  script([
    { text: 'Building it now.', toolCalls: [call('write_file', { path: 'site/index.html', content: '<h1>Hi</h1>' })] },
    { text: '', toolCalls: [call('open', { target: 'site/index.html' })] },
    { text: 'Your website is in ORBIT Workspace/site and open in your browser.', toolCalls: [] },
  ]);
  const ev = await run('Can you create me a website?');
  assert.ok(ev.some((e) => e.type === 'approve' && /Write site\/index.html/.test(e.summary)), 'asked before writing');
  assert.deepEqual(done.map((d) => d.cap), ['files.write', 'files.open']);
  assert.equal(done[0].params.content, '<h1>Hi</h1>');
  assert.equal(ev.filter((e) => e.type === 'tool' && e.status === 'ok').length, 2);
  assert.match(ev.find((e) => e.type === 'done').text, /ORBIT Workspace\/site/);
});

test('declined actions never run, and the AI is told', async () => {
  done.length = 0;
  const seen = script([{ text: '', toolCalls: [call('run_command', { command: 'rm -rf build' })] }, { text: 'Okay, I left it alone.', toolCalls: [] }]);
  const ev = await run('clean up the build folder in my project', { approve: 'no' });
  assert.equal(done.length, 0);
  assert.match(seen.at(-1).content, /declined/);
  assert.ok(ev.some((e) => e.type === 'tool' && e.status === 'failed'));
});

test('"allow for this session" stops repeat prompts; Full control removes them', async () => {
  done.length = 0;
  orbit.engine.agent.reset('sess');
  script([{ text: '', toolCalls: [call('run_command', { command: 'node -v' })] }, { text: '', toolCalls: [call('run_command', { command: 'npm -v' })] }, { text: 'Done.', toolCalls: [] }]);
  let ev = await run('install the packages for my project', { approve: 'session' });
  assert.equal(ev.filter((e) => e.type === 'approve').length, 1, 'asked once');
  assert.equal(done.length, 2);

  orbit.engine.agent.reset('sess');
  orbit.engine.settings.data.fullControl = true;
  script([{ text: '', toolCalls: [call('run_command', { command: 'node -v' })] }, { text: 'Done.', toolCalls: [] }]);
  ev = await run('build my project', { approve: 'none' });
  assert.equal(ev.filter((e) => e.type === 'approve').length, 0, 'no prompts in Full control');
  assert.equal(done.at(-1).params.anyPath, true, 'any folder allowed in Full control');
  orbit.engine.settings.data.fullControl = false;
});

test('switched-off permissions are refused, coding sessions keep context', async () => {
  orbit.devices.setPermissions(paired.device.id, ['app.open']);
  const seen = script([{ text: '', toolCalls: [call('read_file', { path: 'a.js' })] }, { text: 'I need file access.', toolCalls: [] }]);
  await run('fix my code', { mode: 'code' });
  assert.match(seen.at(-1).content, /Not permitted.*Security/);
  script([{ text: 'Still here.', toolCalls: [] }]);
  const seen2 = script([{ text: 'Continuing.', toolCalls: [] }]);
  await run('continue', { mode: 'code' });
  assert.equal(seen2.length, 1);
  const hist = orbit.engine.agent.sessions.get('sess');
  assert.ok(hist.some((m) => m.content === 'fix my code'), 'earlier turns kept in the coding session');
});

test('tool-call message formats for OpenAI-compatible and Anthropic', async () => {
  const msgs = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'a' } }] }, { role: 'tool', id: 't1', name: 'read_file', content: 'x' }];
  const o = _test.toOpenAI('sys', msgs);
  assert.equal(o[2].tool_calls[0].function.arguments, '{"path":"a"}');
  assert.deepEqual(o[3], { role: 'tool', tool_call_id: 't1', content: 'x' });
  const a = _test.toAnthropic(msgs);
  assert.equal(a[1].content[0].type, 'tool_use');
  assert.equal(a[2].content[0].type, 'tool_result');

  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'open', arguments: '{"target":"Spotify"}' } }] } }] }));
  const r = await complete({ kind: 'openai', apiKey: 'k', baseUrl: 'https://example/v1', model: 'm', system: 's', messages: msgs, tools: [] });
  assert.deepEqual(r.toolCalls[0], { id: 'x', name: 'open', args: { target: 'Spotify' } });
  globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'y', name: 'media', input: { action: 'play' } }] }));
  const r2 = await complete({ kind: 'anthropic', apiKey: 'k', model: 'm', system: 's', messages: msgs, tools: [] });
  assert.equal(r2.text, 'ok'); assert.equal(r2.toolCalls[0].name, 'media');
  globalThis.fetch = real;
});
