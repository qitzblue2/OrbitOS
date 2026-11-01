import { Core, stateLabel } from './core.js';
import { createVoice } from './voice.js';

// ---- tiny DOM helper (no innerHTML with user data) ----
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const $ = (s) => document.querySelector(s);
const ago = (iso) => { if (!iso) return 'never'; const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? 'now' : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const svg = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); for (const p of d.split('|')) { const e = document.createElementNS(s.namespaceURI, 'path'); e.setAttribute('d', p); s.append(e); } return s; };

const NAV = [
  ['dashboard', 'Dashboard', 'M3 12 12 3l9 9|M5 10v10h14V10'],
  ['conversations', 'Conversations', 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  ['devices', 'Devices', 'M2 5h20v12H2z|M8 21h8|M12 17v4'],
  ['automations', 'Automations', 'M13 2 3 14h9l-1 8 10-12h-9z'],
  ['memory', 'Memory', 'M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z|M9 21h6'],
  ['integrations', 'Integrations', 'M9 2v6|M15 2v6|M6 8h12v4a6 6 0 0 1-12 0z|M12 18v4'],
  ['voice', 'Voice', 'M9 2h6v12H9z|M19 10v1a7 7 0 0 1-14 0v-1|M12 18v4'],
  ['ai', 'AI configuration', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z|M2 12c3-6 17-6 20 0-3 6-17 6-20 0z'],
  ['security', 'Security', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
];

const S = { token: '', ws: null, overview: null, view: 'dashboard', state: 'idle', chat: [], live: '', heard: '', notes: [], memRecalled: [], actions: [] };
const voice = createVoice();
const native = window.orbitNative || null;
const report = (d) => native?.report(d);
let core, mini;

// ---- auth ----
function getToken() { try { return localStorage.getItem('orbit.token') || ''; } catch { return ''; } }
function setToken(t) { try { localStorage.setItem('orbit.token', t); } catch {} }
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { authorization: `Bearer ${S.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin('Your token was rejected.'); throw new Error('unauthorized'); }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { code: data.code });
  return data;
}
function showLogin(err = '') { $('#app').hidden = true; $('#login').hidden = false; $('#login-error').textContent = err; $('#token').focus(); }
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault(); S.token = $('#token').value.trim();
  try { await api('GET', '/api/overview'); setToken(S.token); start(); } catch (err) { if (err.message !== 'unauthorized') $('#login-error').textContent = err.message; }
});

// ---- realtime link ----
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/ui?token=${encodeURIComponent(S.token)}`);
  S.ws = ws;
  ws.onopen = () => { $('#offline').hidden = true; $('#link-dot').className = 'dot on'; $('#link-text').textContent = 'Linked'; };
  ws.onclose = () => { $('#offline').hidden = false; $('#link-dot').className = 'dot off'; $('#link-text').textContent = 'Offline'; setState('error'); setTimeout(connect, 2000); };
  ws.onmessage = (ev) => onEvent(JSON.parse(ev.data));
}
const send = (m) => S.ws?.readyState === 1 && S.ws.send(JSON.stringify(m));

function onEvent(m) {
  switch (m.type) {
    case 'hello': S.overview = m.overview; applySettings(); if (!S.greeted) { S.greeted = true; } render(); break;
    case 'state': setState(m.state === 'speaking' && !voice.supported.tts ? 'processing' : m.state); if (m.model) S.lastModel = `${m.tier} · ${m.model}`; updateChip(); break;
    case 'delta': S.live += m.text; if (voice.mode !== 'off' || S.speakReplies) voice.feed(m.text); renderLive(); break;
    case 'done': {
      const text = m.text ?? S.live;
      if (!S.live && text && (voice.mode !== 'off' || S.speakReplies)) voice.say(text); else voice.flush();
      if (text) S.chat.push({ role: 'orbit', text, ok: m.ok, ms: m.ms, route: m.route });
      report({ reply: text || '', phase: m.ok === false ? 'error' : 'idle' });
      S.live = ''; renderLive(); refresh(); break;
    }
    case 'action': S.actions.unshift({ ...m, at: new Date().toISOString() }); S.actions.length = Math.min(S.actions.length, 20); if (S.view === 'dashboard') render(); break;
    case 'confirm': toast(m.prompt, 'warn', [h('button', { class: 'btn small primary', onclick: () => utter('yes') }, 'Confirm'), h('button', { class: 'btn small', onclick: () => utter('cancel') }, 'Cancel')]); break;
    case 'memory': if (m.recalled) S.memRecalled = m.recalled; refresh(); break;
    case 'devices': if (S.overview) { S.overview.devices = m.devices; if (['dashboard', 'devices', 'security'].includes(S.view)) render(); } break;
    case 'recent': if (S.overview) { S.overview.recent = m.recent; if (S.view === 'dashboard') render(); } break;
    case 'notify': S.notes.unshift({ ...m, at: new Date().toISOString() }); toast(m.text, m.level === 'warn' ? 'warn' : ''); if (m.speak) voice.say(m.text); if (S.view === 'dashboard') render(); break;
    case 'mic': if (!m.enabled) voice.killAll(); break;
    case 'error': toast(m.message, 'bad'); break;
  }
}

function setState(s) {
  if (s === 'listening-ready') s = voice.mode === 'wake' ? 'idle' : 'idle';
  S.state = s; const shown = voice.mode === 'off' && s === 'idle' ? 'idle' : s;
  report({ phase: shown });
  core?.setState(shown); mini?.setState(shown);
  const label = $('#core-state'); if (label) label.textContent = stateLabel(shown);
  clearTimeout(S.errTimer); if (s === 'error') S.errTimer = setTimeout(() => S.state === 'error' && setState('idle'), 4000);
}
function updateChip() { const b = S.overview?.brain; $('#model-chip').textContent = S.lastModel || (b ? `${b.provider} · ${b.fastModel}` : '—'); }

function utter(text, source = 'text') {
  text = text.trim(); if (!text) return;
  voice.interrupt('new');
  S.heard = text; S.chat.push({ role: 'user', text }); S.live = '';
  send({ type: 'utterance', text, source });
  renderLive();
}

// ---- voice wiring ----
let lastLevel = 0;
voice.addEventListener('level', (e) => { core?.setLevel(e.detail); mini?.setLevel(e.detail); if (native && performance.now() - lastLevel > 80) { lastLevel = performance.now(); report({ level: e.detail }); } });
voice.addEventListener('ready', () => { if (S.view === 'voice') render(); });
voice.addEventListener('models', (e) => { const m = e.detail; if (m.status === 'downloading') { S.models = `Downloading voice models… ${Math.round(m.fraction * 100)}%`; } else S.models = ''; if (S.view === 'voice') render(); });
voice.addEventListener('state', (e) => setState(e.detail));
voice.addEventListener('interim', (e) => { S.heard = e.detail; renderLive(); report({ heard: e.detail }); });
voice.addEventListener('utterance', (e) => utter(e.detail.text, 'voice'));
voice.addEventListener('interrupt', () => send({ type: 'interrupt' }));
voice.addEventListener('error', (e) => toast(e.detail, 'bad'));
voice.addEventListener('mode', (e) => {
  const on = e.detail !== 'off';
  report({ listening: on });
  $('#mic-toggle').setAttribute('aria-pressed', String(on));
  $('#mic-label').textContent = e.detail === 'starting' ? 'Starting voice engine…' : e.detail === 'wake' ? 'Listening for "Hey Orbit"' : on ? 'Mic on' : 'Mic off';
  if (e.detail === 'starting') return;
  setState(on ? 'idle' : 'idle');
});
$('#mic-toggle').addEventListener('click', () => voice.setMode(voice.mode === 'off' ? 'wake' : 'off'));
const ptt = $('#ptt');
const pttDown = (e) => { e.preventDefault(); ptt.setAttribute('aria-pressed', 'true'); voice.pttStart(); };
const pttUp = () => { if (ptt.getAttribute('aria-pressed') !== 'true') return; ptt.setAttribute('aria-pressed', 'false'); voice.pttEnd(); };
ptt.addEventListener('pointerdown', pttDown); ptt.addEventListener('pointerup', pttUp); ptt.addEventListener('pointerleave', pttUp);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { voice.killAll(); send({ type: 'interrupt' }); toast('Listening is off.'); }
  if (e.code === 'Space' && !e.repeat && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(document.activeElement.tagName)) pttDown(e);
});
addEventListener('keyup', (e) => { if (e.code === 'Space') pttUp(); });
$('#ask').addEventListener('submit', (e) => { e.preventDefault(); const i = $('#ask-input'); utter(i.value); i.value = ''; });

function applySettings() { const s = S.overview?.settings; if (s?.voice) voice.voice = { ...voice.voice, ...s.voice }; S.speakReplies = !!s?.voice?.speakTyped; updateChip(); }
async function refresh() { try { S.overview = await api('GET', '/api/overview'); updateChip(); if (S.view !== 'conversations' || !S.live) render(); } catch {} }

// ---- toasts ----
function toast(text, kind = '', actions = []) {
  const t = h('div', { class: `toast glass ${kind}`, role: kind === 'bad' ? 'alert' : 'status' }, h('div', {}, text), actions.length ? h('div', { class: 'row' }, actions) : null);
  $('#toasts').append(t);
  actions.forEach((a) => a.addEventListener('click', () => t.remove()));
  setTimeout(() => t.remove(), actions.length ? 30000 : 5000);
}

// ---- navigation ----
function buildNav() {
  const ul = $('#nav'); ul.replaceChildren();
  for (const [id, label, icon] of NAV) ul.append(h('li', {}, h('button', { type: 'button', 'aria-current': S.view === id ? 'page' : null, onclick: () => go(id), title: label }, svg(icon), h('span', {}, label))));
}
function go(v) { S.view = v; try { history.replaceState(null, '', `#${v}`); } catch {} buildNav(); render(); $('#view').focus(); }

// ---- views ----
const panel = (title, ...kids) => h('div', { class: 'panel' }, h('h2', {}, title), ...kids);
const empty = (t) => h('div', { class: 'empty' }, t);

function renderLive() {
  const el = $('#transcript'); if (el) el.replaceChildren(...[S.heard ? h('span', { class: 'you' }, `“${S.heard}”`) : null, S.live || (S.chat.at(-1)?.role === 'orbit' ? S.chat.at(-1).text : '')].filter(Boolean));
  if (S.view === 'conversations') renderChat();
}

const VIEWS = {
  dashboard() {
    const o = S.overview; const online = o.devices.filter((d) => d.online);
    const canvas = h('canvas', { class: 'core', id: 'core', 'aria-hidden': 'true' });
    const view = h('div', { class: 'hud' },
      h('div', { class: 'stack' },
        panel('System',
          h('div', { class: 'stats' },
            h('div', { class: 'stat' }, h('span', {}, 'Status'), h('b', { id: 'core-state' }, stateLabel(S.state))),
            h('div', { class: 'stat' }, h('span', {}, 'Microphone'), h('b', {}, voice.mode === 'wake' ? 'Wake' : voice.mode === 'off' ? 'Off' : 'On')),
            h('div', { class: 'stat' }, h('span', {}, 'Devices'), h('b', {}, `${online.length}/${o.devices.length}`)),
            h('div', { class: 'stat' }, h('span', {}, 'Memories'), h('b', {}, o.memoryCount)))),
        panel('Connected devices', o.devices.length ? h('ul', { class: 'list' }, o.devices.map((d) => h('li', {}, h('span', { class: `dot ${d.online ? 'on' : ''}` }), h('span', { class: 'grow' }, d.name), h('span', { class: 'meta' }, d.platform)))) : empty('No devices yet. Pair one from Devices.')),
        panel('AI', h('ul', { class: 'list' },
          h('li', {}, h('span', { class: 'grow' }, 'Provider'), h('span', { class: 'meta' }, o.brain.provider)),
          h('li', {}, h('span', { class: 'grow' }, 'Fast'), h('span', { class: 'meta' }, o.brain.fastModel)),
          h('li', {}, h('span', { class: 'grow' }, 'Reasoning'), h('span', { class: 'meta' }, o.brain.reasoningModel))))),
      h('div', { class: 'core-wrap' }, canvas, h('div', { class: 'core-state', id: 'core-label' }, 'ORBIT'), h('div', { class: 'transcript', id: 'transcript' })),
      h('div', { class: 'stack' },
        panel('Recent commands', o.recent.length ? h('ul', { class: 'list' }, o.recent.slice(0, 7).map((r) => h('li', {}, h('span', { class: `tag ${r.ok ? '' : 'bad'}` }, r.kind.replace('ai:', 'ai ')), h('span', { class: 'grow', title: r.reply || '' }, r.said), h('span', { class: 'meta' }, `${r.ms}ms`)))) : empty('Say "Hey Orbit" or type below.')),
        panel('Active tasks', S.actions.length ? h('ul', { class: 'list' }, S.actions.slice(0, 5).map((a) => h('li', {}, h('span', { class: `tag ${a.status === 'failed' ? 'bad' : a.status === 'ok' ? 'ok' : ''}` }, a.status), h('span', { class: 'grow' }, a.routine ? `${a.routine}: ${a.step}` : `${a.capability} · ${a.device}`)))) : empty('Nothing running.')),
        panel('Notifications', S.notes.length || o.reminders.length ? h('ul', { class: 'list' }, [...S.notes.slice(0, 3).map((n) => h('li', {}, h('span', { class: 'grow' }, n.text), h('span', { class: 'meta' }, ago(n.at)))), ...o.reminders.slice(0, 3).map((r) => h('li', {}, h('span', { class: 'grow' }, r.text), h('span', { class: 'meta' }, new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))))]) : empty('All quiet.')),
        panel('Memory activity', S.memRecalled.length ? h('ul', { class: 'list' }, o.memoryCount ? S.memRecalled.map((id) => h('li', {}, h('span', { class: 'grow' }, `Recalled ${id.slice(0, 8)}`))) : []) : empty(`${o.memoryCount} memories stored. None recalled yet.`))));
    setTimeout(() => { core = new Core(canvas); core.setState(S.state); renderLive(); });
    return view;
  },

  conversations() {
    const box = h('div', { class: 'chat', id: 'chat' });
    setTimeout(renderChat);
    return panel('This session', box);
  },

  devices() {
    const o = S.overview;
    const codeBox = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Generate a one-time code, then run the Companion on the device you want ORBIT to control.'),
      h('button', { class: 'btn primary', onclick: async () => {
        const { code, expiresAt } = await api('POST', '/api/devices/pairing-code');
        codeBox.replaceChildren(h('div', { class: 'code' }, code), h('p', { class: 'muted' }, `Valid until ${new Date(expiresAt).toLocaleTimeString()}. On the device run:`),
          h('pre', { class: 'cmd' }, `node companion/agent.js pair ${location.origin} ${code} "My laptop"\nnode companion/agent.js`));
      } }, 'Pair a new device'));
    return h('div', { class: 'grid2' },
      panel('Pair', codeBox),
      panel('Your devices', o.devices.length ? h('ul', { class: 'list' }, o.devices.map((d) => h('li', {},
        h('span', { class: `dot ${d.online ? 'on' : ''}` }),
        h('span', { class: 'grow' }, h('b', {}, d.name), h('div', { class: 'muted mono' }, `${d.platform} · ${d.online ? 'online' : `seen ${ago(d.lastSeen)}`}${d.status?.battery != null ? ` · ${d.status.battery}%` : ''}${d.status?.cpu != null ? ` · cpu ${d.status.cpu}%` : ''}`)),
        h('button', { class: 'btn small', onclick: () => go('security') }, 'Permissions')))) : empty('No devices paired.')));
  },

  automations() {
    const o = S.overview;
    const name = h('input', { id: 'r-name', placeholder: 'movie' }), steps = h('textarea', { id: 'r-steps', rows: '4', placeholder: 'set the living room lights to 20 percent\nset volume to 60\nopen netflix' });
    const remText = h('input', { id: 'rem-text', placeholder: 'Call the dentist' }), remAt = h('input', { id: 'rem-at', type: 'datetime-local' });
    return h('div', { class: 'grid2' },
      panel('Routines', h('ul', { class: 'list' }, o.routines.map((r) => h('li', {}, h('span', { class: 'grow' }, h('b', {}, r.label), h('div', { class: 'muted' }, r.steps.join(' → '))),
        h('button', { class: 'btn small', onclick: () => utter(`start ${r.name} mode`) }, 'Run'),
        h('button', { class: 'btn small ghost', 'aria-label': `Edit ${r.label}`, onclick: () => { name.value = r.name; steps.value = r.steps.join('\n'); name.dataset.id = r.id; } }, 'Edit'),
        h('button', { class: 'btn small danger', 'aria-label': `Delete ${r.label}`, onclick: async () => { await api('DELETE', `/api/automations/${r.id}`); refresh(); } }, 'Delete'))))),
      panel('Create or edit a routine',
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'r-name' }, 'Name (say "start <name> mode")'), name),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'r-steps' }, 'Steps, one command per line'), steps),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { await api('POST', '/api/automations', { id: name.dataset.id, name: name.value, label: name.value.replace(/^\w/, (c) => c.toUpperCase()), steps: steps.value.split('\n') }); name.value = steps.value = ''; delete name.dataset.id; refresh(); } }, 'Save routine'))),
      panel('Reminders',
        h('ul', { class: 'list' }, o.reminders.map((r) => h('li', {}, h('span', { class: 'grow' }, r.text), h('span', { class: 'meta' }, new Date(r.at).toLocaleString()), h('button', { class: 'btn small', onclick: async () => { await api('POST', `/api/reminders/${r.id}/done`); refresh(); } }, 'Done')))),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'rem-text' }, 'Remind me to'), remText),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'rem-at' }, 'When'), remAt),
        h('button', { class: 'btn primary', onclick: async () => { if (!remText.value || !remAt.value) return; await api('POST', '/api/reminders', { text: remText.value, at: new Date(remAt.value).toISOString() }); refresh(); } }, 'Add reminder')));
  },

  memory() {
    const o = S.overview;
    const text = h('input', { id: 'm-text', placeholder: 'I prefer metric units' });
    const kind = h('select', { id: 'm-kind' }, o.memoryKinds.map((k) => h('option', { value: k }, k)));
    const list = h('ul', { class: 'list' });
    api('GET', '/api/memory').then((items) => list.replaceChildren(...(items.length ? items.slice().reverse().map((m) => {
      const input = h('input', { value: m.text, 'aria-label': 'Memory text' });
      return h('li', {}, h('span', { class: 'tag' }, m.kind), h('span', { class: 'grow' }, input),
        h('button', { class: 'btn small', onclick: async () => { await api('PATCH', `/api/memory/${m.id}`, { text: input.value }); toast('Memory updated.'); } }, 'Save'),
        h('button', { class: 'btn small danger', onclick: async () => { await api('DELETE', `/api/memory/${m.id}`); refresh(); } }, 'Delete'));
    }) : [empty('ORBIT has no permanent memories yet. Say "remember that…" or add one here.')])));
    const add = async (allowSensitive = false) => {
      try { await api('POST', '/api/memory', { text: text.value, kind: kind.value, allowSensitive }); text.value = ''; refresh(); }
      catch (e) { if (e.code === 'SENSITIVE') toast('This looks sensitive. Store it anyway?', 'warn', [h('button', { class: 'btn small primary', onclick: () => add(true) }, 'Store it'), h('button', { class: 'btn small' }, 'Cancel')]); else toast(e.message, 'bad'); }
    };
    return h('div', { class: 'stack' },
      panel('Add a memory', h('div', { class: 'row' }, h('div', { class: 'field grow' }, h('label', { class: 'label', for: 'm-text' }, 'What should ORBIT remember?'), text), h('div', { class: 'field' }, h('label', { class: 'label', for: 'm-kind' }, 'Type'), kind), h('button', { class: 'btn primary', onclick: () => add() }, 'Remember'))),
      panel(`Permanent memories (${o.memoryCount})`, list,
        h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Conversation context is temporary and is never written to disk.'), h('button', { class: 'btn small danger', onclick: async () => { if (confirm('Delete every memory?')) { await api('DELETE', '/api/memory'); refresh(); } } }, 'Clear all'))));
  },

  integrations() {
    const o = S.overview;
    return h('div', { class: 'grid2' },
      panel('Smart home', h('ul', { class: 'list' },
        h('li', {}, h('span', { class: `dot ${o.home.simulated ? '' : 'on'}` }), h('span', { class: 'grow' }, o.home.name), o.home.simulated ? h('span', { class: 'tag bad' }, 'simulated') : h('span', { class: 'tag ok' }, 'connected'))),
        h('p', { class: 'muted' }, 'Set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN (recommended, covers Hue, plugs, thermostats, sensors and cameras) or HUE_BRIDGE_IP and HUE_USERNAME in the server .env, then restart.')),
      panel('Try it', h('div', { class: 'row' }, ['turn off all the lights', 'set the bedroom lights to 30 percent', "what's the temperature in my room", 'activate movie mode', 'good morning'].map((c) => h('button', { class: 'btn small', onclick: () => utter(c) }, c)))));
  },

  voice() {
    const s = S.overview.settings;
    const voices = (speechSynthesis?.getVoices?.() || []);
    const vSel = h('select', { id: 'v-name' }, h('option', { value: '' }, 'System default'), voices.map((v) => h('option', { value: v.name, selected: v.name === s.voice.name }, `${v.name} (${v.lang})`)));
    const rate = h('input', { id: 'v-rate', type: 'range', min: '0.7', max: '1.5', step: '0.05', value: s.voice.rate });
    const pitch = h('input', { id: 'v-pitch', type: 'range', min: '0.6', max: '1.4', step: '0.05', value: s.voice.pitch });
    const save = async () => { const v = { name: vSel.value, rate: +rate.value, pitch: +pitch.value, speakTyped: s.voice.speakTyped }; voice.voice = v; S.overview.settings = await api('PATCH', '/api/settings', { voice: v }); };
    const nativePanel = native ? panel('On-device voice engine',
      h('ul', { class: 'list' },
        h('li', {}, h('span', { class: `dot ${voice.ready ? 'on' : ''}` }), h('span', { class: 'grow' }, voice.ready ? 'Ready' : (S.models || 'Starting…'), h('div', { class: 'muted' }, 'Wake word, speech recognition and the voice all run on this computer. Audio is not sent anywhere for them.'))),
        h('li', {}, h('span', { class: 'grow' }, 'Wake word sensitivity', h('div', { class: 'muted' }, 'Higher hears you from further away but may wake by mistake more often.')),
          (() => { const r = h('input', { type: 'range', min: '0.02', max: '0.3', step: '0.02', 'aria-label': 'Wake word sensitivity', value: String(0.32 - (voice.info?.sensitivity ?? 0.08)) }); r.addEventListener('change', () => { native.setSensitivity(0.32 - +r.value); toast('Sensitivity updated. The voice engine is restarting.'); }); return r; })()),
        h('li', {}, h('span', { class: 'grow' }, 'Start ORBIT when I log in', h('div', { class: 'muted' }, 'Runs in the tray so "Hey Orbit" works without opening the app.')),
          (() => { const b = h('button', { class: 'switch', role: 'switch', 'aria-label': 'Start ORBIT when I log in', 'aria-checked': String(!!voice.info?.launchAtLogin) }); b.addEventListener('click', async () => { const on = await native.setLaunchAtLogin(b.getAttribute('aria-checked') !== 'true'); b.setAttribute('aria-checked', String(on)); if (voice.info) voice.info.launchAtLogin = on; }); return b; })()),
        h('li', {}, h('span', { class: 'grow' }, 'Global push to talk', h('div', { class: 'muted' }, `Press ${native.platform === 'darwin' ? '⌥ Space' : 'Alt+Space'} in any app, speak, press again to send.`))))) : null;
    return h('div', { class: 'grid2' },
      nativePanel,
      panel('Listening',
        h('ul', { class: 'list' },
          h('li', {}, h('span', { class: 'grow' }, 'Wake phrase "Hey Orbit"', h('div', { class: 'muted' }, native ? 'Detected on this computer.' : 'In a browser this uses the browser\'s speech service. Install the ORBIT app for fully on-device listening.')), h('button', { class: 'btn small', onclick: () => voice.setMode(voice.mode === 'wake' ? 'off' : 'wake') }, voice.mode === 'wake' ? 'Turn off' : 'Turn on')),
          h('li', {}, h('span', { class: 'grow' }, 'Push to talk', h('div', { class: 'muted' }, 'Hold Space, or hold the mic button in the dock.'))),
          h('li', {}, h('span', { class: 'grow' }, 'Stop everything instantly', h('div', { class: 'muted' }, 'Press Esc or say "stop listening".'))),
          h('li', {}, h('span', { class: 'grow' }, 'Speak replies to typed commands'), h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!s.voice.speakTyped), 'aria-label': 'Speak replies to typed commands', onclick: async (e) => { s.voice.speakTyped = !s.voice.speakTyped; S.speakReplies = s.voice.speakTyped; e.currentTarget.setAttribute('aria-checked', String(s.voice.speakTyped)); await save(); } }))),
        !voice.supported.stt ? h('p', { class: 'error-text' }, 'This browser has no speech recognition. Use Chrome or Edge.') : null),
      panel('Voice',
        native ? null : h('div', { class: 'field' }, h('label', { class: 'label', for: 'v-name' }, 'Voice'), vSel),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'v-rate' }, 'Speaking speed'), rate),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'v-pitch' }, 'Pitch'), pitch),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: save }, 'Save'), h('button', { class: 'btn', onclick: async () => { await save(); voice.say("Good evening. I'm here. What can I do for you?"); } }, 'Preview'))));
  },

  ai() {
    const o = S.overview, s = o.settings;
    const name = h('input', { id: 'ai-user', value: s.userName, placeholder: 'Alex' });
    const tone = h('select', { id: 'ai-tone' }, ['composed', 'concise', 'warm', 'witty', 'formal'].map((t) => h('option', { value: t, selected: t === s.tone }, t)));
    const fast = h('input', { id: 'ai-fast', value: o.brain.fastModel }), deep = h('input', { id: 'ai-deep', value: o.brain.reasoningModel });
    const prov = h('select', { id: 'ai-prov' }, ['anthropic', 'offline'].map((p) => h('option', { value: p, selected: p === o.brain.provider }, p)));
    return h('div', { class: 'grid2' },
      panel('Personality',
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'ai-user' }, 'What should ORBIT call you?'), name),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'ai-tone' }, 'Tone'), tone),
        h('button', { class: 'btn primary', onclick: async () => { S.overview.settings = await api('PATCH', '/api/settings', { userName: name.value, tone: tone.value }); toast('Saved.'); } }, 'Save')),
      panel('Models',
        h('p', { class: 'muted' }, 'Simple requests go to the fast model; analysis, code, planning and screenshots go to the reasoning model. Device commands never reach a model.'),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'ai-prov' }, 'Provider'), prov),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'ai-fast' }, 'Fast model'), fast),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'ai-deep' }, 'Reasoning model'), deep),
        h('button', { class: 'btn primary', onclick: async () => { S.overview.brain = await api('PATCH', '/api/ai', { provider: prov.value, fastModel: fast.value, reasoningModel: deep.value }); updateChip(); toast(`Using ${S.overview.brain.provider}.`); render(); } }, 'Apply')));
  },

  security() {
    const o = S.overview;
    const log = h('ul', { class: 'list' });
    api('GET', '/api/audit').then((rows) => log.replaceChildren(...(rows.length ? rows.slice(0, 40).map((r) => h('li', {}, h('span', { class: `tag ${r.ok === false ? 'bad' : 'ok'}` }, r.kind), h('span', { class: 'grow' }, [r.device, r.capability || r.action || r.routine, r.message || r.reason].filter(Boolean).join(' · ')), h('span', { class: 'meta' }, ago(r.at)))) : [empty('No actions logged yet.')])));
    const devicePanels = o.devices.map((d) => panel(d.name,
      ...Object.entries(o.capabilities).map(([cap, def]) => h('div', { class: 'perm' }, h('span', {}, def.label, def.sensitive ? h('span', { class: 'sens' }, 'asks first') : null, def.privacy ? h('span', { class: 'sens' }, 'privacy') : null),
        h('button', { class: 'switch', role: 'switch', 'aria-label': `${def.label} on ${d.name}`, 'aria-checked': String(d.permissions.includes(cap)), onclick: async () => {
          const next = d.permissions.includes(cap) ? d.permissions.filter((p) => p !== cap) : [...d.permissions, cap];
          await api('PATCH', `/api/devices/${d.id}`, { permissions: next }); refresh();
        } }))),
      h('div', { class: 'row' }, h('button', { class: 'btn danger', onclick: async () => { if (confirm(`Revoke ${d.name}? It will be disconnected immediately and must be paired again.`)) { await api('DELETE', `/api/devices/${d.id}`); refresh(); } } }, 'Revoke access'))));
    return h('div', { class: 'stack' }, h('div', { class: 'grid2' }, ...(devicePanels.length ? devicePanels : [panel('Device permissions', empty('No devices paired.'))])),
      panel('Data', h('p', { class: 'muted' }, 'API keys live only in the server .env. The dashboard uses a separate access token. Device credentials are stored hashed and can be revoked at any time. Screenshots are analysed in memory and never written to the server.')),
      panel('Audit log', log));
  },
};

function renderChat() {
  const box = $('#chat'); if (!box) return;
  const msgs = S.chat.map((m) => h('div', { class: `msg ${m.role}` }, m.text, m.role === 'orbit' && m.ms != null ? h('div', { class: 'muted mono' }, `${m.route || 'local'} · ${m.ms} ms`) : null));
  if (S.live) msgs.push(h('div', { class: 'msg orbit' }, S.live));
  box.replaceChildren(...(msgs.length ? msgs : [empty('No conversation yet in this session.')]));
}

function render() {
  if (!S.overview) return;
  $('#view-title').textContent = NAV.find((n) => n[0] === S.view)[1];
  if (S.view !== 'dashboard') core = null;
  $('#view').replaceChildren(VIEWS[S.view]());
}

function start() {
  $('#login').hidden = true; $('#app').hidden = false;
  S.view = NAV.some((n) => n[0] === location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard';
  buildNav(); mini = new Core($('#core-mini'), { mini: true });
  connect();
}

S.token = new URLSearchParams(location.hash.split('?')[1] || '').get('token') || getToken();
if (S.token) api('GET', '/api/overview').then(() => { setToken(S.token); start(); }).catch(() => {}); else showLogin();
speechSynthesis?.addEventListener?.('voiceschanged', () => { if (S.view === 'voice') render(); });
