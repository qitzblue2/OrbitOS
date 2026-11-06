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
  e.preventDefault();
  const v = $('#token').value.trim();
  // A 6-digit code pairs this phone (or browser) once and gets it its own key.
  if (/^\d{6}$/.test(v)) {
    const ua = navigator.userAgent;
    const name = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Browser';
    let r, j = {};
    try { r = await fetch('/api/phone/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: v, name }) }); j = await r.json().catch(() => ({})); }
    catch { $('#login-error').textContent = "Can't reach ORBIT. Check the phone is on the same Wi-Fi (or use the server's https address)."; return; }
    if (!r.ok) { $('#login-error').textContent = `${j.error || 'Pairing failed.'} Make sure the code came from ORBIT at ${location.host}.`; return; }
    S.token = j.token; setToken(S.token); start(); return;
  }
  S.token = v;
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
    case 'state': setState(m.state === 'speaking' && !voice.supported.tts ? 'processing' : m.state); if (m.model) S.lastModel = `${m.provider} · ${m.model}${m.failovers ? ` · switched ${m.failovers}×` : ''}`; updateChip(); break;
    case 'thinking': if (S.pending) S.pending.thinking = true; renderLive(); break;
    case 'agent-note': S.chat.push({ role: 'note', text: m.text }); renderLive(); break;
    case 'tool': {
      const t = S.chat.find((x) => x.role === 'tool' && x.callId === m.callId);
      if (t) Object.assign(t, { status: m.status, output: m.output }); else S.chat.push({ role: 'tool', ...m });
      if (S.pending) S.pending.at = Date.now(); renderLive(); break;
    }
    case 'approve':
      S.chat.push({ role: 'approve', ...m, state: 'pending' });
      if (S.view !== 'conversations') toast(`ORBIT wants to: ${m.summary}`, 'warn', [h('button', { class: 'btn small primary', onclick: () => answerApproval(m.id, true) }, 'Approve'), h('button', { class: 'btn small', onclick: () => go('conversations') }, 'Review')]);
      renderLive(); break;
    case 'delta': S.pending = null; S.live += m.text; if (voice.mode !== 'off' || S.speakReplies) voice.feed(m.text); renderLive(); break;
    case 'done': {
      const text = m.text ?? S.live;
      if (!S.live && text && (voice.mode !== 'off' || S.speakReplies)) voice.say(text); else voice.flush();
      if (text) S.chat.push({ role: 'orbit', text, ok: m.ok, ms: m.ms, route: m.route });
      report({ reply: text || '', phase: m.ok === false ? 'error' : 'idle' });
      S.live = ''; S.pending = null; renderLive(); refresh(); break;
    }
    case 'action': S.actions.unshift({ ...m, at: new Date().toISOString() }); S.actions.length = Math.min(S.actions.length, 20); if (S.view === 'dashboard') render(); break;
    case 'confirm': toast(m.prompt, 'warn', [h('button', { class: 'btn small primary', onclick: () => utter('yes') }, 'Confirm'), h('button', { class: 'btn small', onclick: () => utter('cancel') }, 'Cancel')]); break;
    case 'memory': if (m.recalled) S.memRecalled = m.recalled; refresh(); break;
    case 'devices': if (S.overview) { S.overview.devices = m.devices; if (['dashboard', 'devices', 'security'].includes(S.view)) render(); } break;
    case 'recent': if (S.overview) { S.overview.recent = m.recent; if (S.view === 'dashboard') render(); } break;
    case 'notify': S.notes.unshift({ ...m, at: new Date().toISOString() }); toast(m.text, m.level === 'warn' ? 'warn' : ''); if (m.speak) voice.say(m.text); if (S.view === 'dashboard') render(); break;
    case 'mic': if (!m.enabled) voice.killAll(); break;
    case 'error': S.pending = null; toast(m.message, 'bad'); renderLive(); break;
    case 'model': S.overview.brain = { ...S.overview.brain, ...m }; S.lastModel = ''; updateChip(); if (S.view === 'ai') render(); break;
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
function updateChip() { const b = S.overview?.brain; $('#model-chip').textContent = S.lastModel || (b ? (b.provider === 'offline' ? 'no AI key · choose model' : `${b.fastModel}${b.reasoningModel !== b.fastModel ? ` + ${b.reasoningModel}` : ''} ▾`) : '—'); }

function utter(text, source = 'text') {
  text = text.trim(); if (!text) return;
  voice.interrupt('new');
  S.heard = text; S.chat.push({ role: 'user', text }); S.live = ''; S.pending = { at: Date.now(), thinking: false }; startPendingTimer();
  send({ type: 'utterance', text, source, mode: S.mode || 'chat' });
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
voice.addEventListener('missed', () => { S.heard = ''; renderLive(); toast("Didn't catch that. Try again a little louder, or check Voice › Microphone.", 'warn'); });
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

function answerApproval(id, ok, session = false) {
  const a = S.chat.find((x) => x.role === 'approve' && x.id === id);
  if (a) a.state = ok ? (session ? 'session' : 'approved') : 'denied';
  send({ type: 'approve', id, ok, session }); renderLive();
}

// Minimal, safe markdown: code fences (with copy), inline code, bold, headings and lists. No HTML is ever injected.
function md(text) {
  const out = [];
  const parts = String(text).split(/```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g);
  for (let i = 0; i < parts.length; i += 3) {
    for (const para of parts[i].split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const lines = para.split('\n');
      if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) out.push(h('ul', { class: 'md-list' }, lines.map((l) => h('li', {}, inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''))))));
      else if (/^#{1,4}\s/.test(para)) out.push(h('div', { class: 'md-h' }, inline(para.replace(/^#+\s*/, ''))));
      else out.push(h('p', { class: 'md-p' }, lines.flatMap((l, j) => [...inline(l), j < lines.length - 1 ? h('br') : null])));
    }
    if (i + 2 < parts.length) {
      const code = parts[i + 2].replace(/\n$/, '');
      const copy = h('button', { class: 'btn small ghost code-copy', onclick: async () => { try { await navigator.clipboard.writeText(code); copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1500); } catch {} } }, 'Copy');
      out.push(h('div', { class: 'code-block' }, h('div', { class: 'code-head' }, h('span', { class: 'mono muted' }, parts[i + 1] || 'code'), copy), h('pre', { class: 'cmd' }, h('code', {}, code))));
    }
  }
  return out;
}
function inline(t) {
  return String(t).split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean).map((x) => (x.startsWith('`') ? h('code', { class: 'md-code' }, x.slice(1, -1)) : x.startsWith('**') ? h('b', {}, x.slice(2, -2)) : x));
}

// ---- model switcher (top bar) ----
const chip = $('#model-chip'), menu = $('#model-menu');
async function openModelMenu() {
  menu.hidden = false; chip.setAttribute('aria-expanded', 'true');
  menu.replaceChildren(h('div', { class: 'group' }, 'Loading models…'));
  let lists = {};
  try { lists = await api('GET', '/api/ai/models'); } catch {}
  const r = S.overview.brain.routes;
  const pick = async (provider, model) => {
    S.overview.brain = await api('PATCH', '/api/ai/routes', { fast: { provider, model }, reasoning: { provider, model } });
    S.lastModel = ''; updateChip(); closeModelMenu(); toast(`ORBIT now uses ${model}.`);
    if (S.view === 'ai') render();
  };
  const groups = Object.entries(lists);
  const search = h('input', { type: 'search', placeholder: 'Search models', 'aria-label': 'Search models', class: 'menu-search' });
  const body = h('div', {});
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    body.replaceChildren(...(groups.length ? groups.flatMap(([provider, g]) => {
      const ms = g.models.filter((m) => !q || m.toLowerCase().includes(q));
      if (!ms.length) return [];
      return [
        h('div', { class: 'group' }, `${g.label} · ${g.source === 'live' ? `${g.models.length} available` : 'suggested, not checked'}`),
        ...ms.slice(0, q ? 80 : 25).map((m) => h('button', { type: 'button', role: 'option', 'aria-selected': String(r.fast.provider === provider && (r.fast.model || '') === m), onclick: () => pick(provider, m) }, m)),
        ms.length > (q ? 80 : 25) ? h('div', { class: 'group' }, `…${ms.length - (q ? 80 : 25)} more, type to search`) : null,
      ];
    }) : [h('div', { class: 'group' }, 'Add an AI key to choose a model')]));
  };
  search.addEventListener('input', draw);
  draw();
  menu.replaceChildren(groups.length ? search : null, body,
    h('div', { class: 'foot' }, h('button', { type: 'button', onclick: () => { closeModelMenu(); go('ai'); } }, 'Separate models for quick and deep answers…')));
  search.focus();
}
function closeModelMenu() { menu.hidden = true; chip.setAttribute('aria-expanded', 'false'); }
chip.addEventListener('click', () => (menu.hidden ? openModelMenu() : closeModelMenu()));
document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.model-switch')) closeModelMenu(); });
menu.addEventListener('keydown', (e) => {
  const items = [...menu.querySelectorAll('button')], i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  if (e.key === 'Escape') { e.stopPropagation(); closeModelMenu(); chip.focus(); }
});

// ---- toasts ----
function toast(text, kind = '', actions = []) {
  const t = h('div', { class: `toast glass ${kind}`, role: kind === 'bad' ? 'alert' : 'status' }, text?.nodeType ? text : h('div', {}, text), actions.length ? h('div', { class: 'row' }, actions) : null);
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

// While waiting for the first words of a reply, show that ORBIT is working (and for how long).
let pendingTimer;
function startPendingTimer() { clearInterval(pendingTimer); pendingTimer = setInterval(() => { if (!S.pending) return clearInterval(pendingTimer); renderLive(); }, 1000); }
const pendingText = () => S.pending && `${S.pending.thinking ? 'Thinking' : 'Working on it'}… ${Math.round((Date.now() - S.pending.at) / 1000)}s`;

function renderLive() {
  const el = $('#transcript'); if (el) el.replaceChildren(...[S.heard ? h('span', { class: 'you' }, `“${S.heard}”`) : null, S.live || pendingText() || (S.chat.at(-1)?.role === 'orbit' ? S.chat.at(-1).text : '')].filter(Boolean));
  if (S.view === 'conversations') renderChat();
}

// Microphone setup for the desktop app: which mic, noise reduction, volume boost, patience and a live test.
function micPanel() {
  const prefs = voice.micPrefs;
  const mics = h('select', { id: 'mic-device', 'aria-label': 'Microphone' }, h('option', { value: '' }, 'System default'));
  const boost = h('select', { id: 'mic-boost', 'aria-label': 'Volume boost' }, [['auto', 'Automatic (recommended)'], ['1', 'Off'], ['2', '2×'], ['4', '4×'], ['8', '8×']].map(([v, l]) => h('option', { value: v, selected: String(prefs.boost) === v }, l)));
  const patience = h('select', { id: 'mic-patience', 'aria-label': 'Wait after I stop talking' }, [['0.6', 'Short (0.6 s)'], ['1', 'Normal (1 s)'], ['1.6', 'Long (1.6 s), for slow or paused speech']].map(([v, l]) => h('option', { value: v }, l)));
  const ns = h('button', { class: 'switch', role: 'switch', 'aria-label': 'Noise reduction', 'aria-checked': String(prefs.noiseSuppression) });
  const bar = h('div', { class: 'meter-fill' }), meter = h('div', { class: 'meter', role: 'meter', 'aria-label': 'Microphone level', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);
  const verdict = h('div', { class: 'muted', 'aria-live': 'polite', id: 'mic-verdict' }, S.micVerdict || 'Press Test and talk normally.');
  const test = h('button', { class: 'btn small' }, 'Test');

  const fillMics = async () => {
    const list = await voice.listMics().catch(() => []);
    mics.replaceChildren(h('option', { value: '' }, 'System default'), ...list.filter((m) => m.id && m.id !== 'default').map((m) => h('option', { value: m.id, selected: m.id === prefs.deviceId }, m.label)));
  };
  fillMics();
  native.getInfo().then((i) => { patience.value = String(i.patience ?? 1); if (!patience.value) patience.value = '1'; });
  mics.addEventListener('change', async () => { await voice.setMicPrefs({ deviceId: mics.value }); toast('Microphone changed.'); });
  boost.addEventListener('change', () => voice.setMicPrefs({ boost: boost.value === 'auto' ? 'auto' : +boost.value }));
  patience.addEventListener('change', async () => { await native.setPatience(+patience.value); toast('Saved. The voice engine is restarting.'); });
  ns.addEventListener('click', async () => { const on = ns.getAttribute('aria-checked') !== 'true'; ns.setAttribute('aria-checked', String(on)); await voice.setMicPrefs({ noiseSuppression: on }); });

  // Live meter: shows level after the boost, and says whether you're loud enough.
  let peak = 0, peakAt = 0, testing = false;
  const off = (() => { const fn = (e) => {
    const { level, raw, gain } = e.detail;
    bar.style.width = `${Math.round(level * 100)}%`; meter.setAttribute('aria-valuenow', String(Math.round(level * 100)));
    if (!testing) return;
    if (raw > peak) { peak = raw; peakAt = performance.now(); }
    if (performance.now() - peakAt > 1500 && peak > 0) {
      const heard = peak * gain;
      verdict.textContent = peak < 0.004 ? 'I can barely hear you. Check the right microphone is selected, or set the boost to 4× or 8×.'
        : heard < 0.05 ? 'A bit quiet. Move closer or raise the boost.' : peak > 0.6 ? 'Very loud, which can distort. Move back a little.' : 'Sounds good.';
      peak = 0;
    }
  }; voice.addEventListener('mic-meter', fn); return () => voice.removeEventListener('mic-meter', fn); })();
  test.addEventListener('click', async () => {
    if (testing) return;
    testing = true; peak = 0; let best = 0; test.textContent = 'Listening…'; verdict.textContent = 'Talk normally for a few seconds.';
    const track = (e) => { best = Math.max(best, e.detail.raw * e.detail.gain); };
    voice.addEventListener('mic-meter', track);
    const wasOff = !voice.stream;
    try { await voice.openMic(); await fillMics(); } catch { verdict.textContent = 'Microphone access was denied.'; testing = false; test.textContent = 'Test'; voice.removeEventListener('mic-meter', track); return; }
    setTimeout(() => {
      voice.removeEventListener('mic-meter', track);
      testing = false; test.textContent = 'Test';
      S.micVerdict = best < 0.01 ? "I couldn't hear you. Check the right microphone is selected, and that ORBIT is allowed to use it."
        : best < 0.05 ? 'Quiet. Move closer, or set the boost to 4× or 8×.' : best > 0.95 ? 'Very loud, which can distort. Move back a little or lower the boost.' : 'Sounds good. ORBIT can hear you clearly.';
      const v = document.getElementById('mic-verdict'); if (v) v.textContent = S.micVerdict; // survives screen redraws
      if (wasOff && voice.mode === 'off') voice.closeMic();
    }, 6000);
  });
  const panelEl = panel('Microphone',
    h('ul', { class: 'list' },
      h('li', {}, h('span', { class: 'grow' }, 'Microphone'), mics),
      h('li', {}, h('span', { class: 'grow' }, 'Level', verdict), test),
      h('li', {}, meter),
      h('li', {}, h('span', { class: 'grow' }, 'Volume boost', h('div', { class: 'muted' }, 'Raises quiet voices automatically so ORBIT hears you from across the room.')), boost),
      h('li', {}, h('span', { class: 'grow' }, 'Noise reduction', h('div', { class: 'muted' }, 'Filters background noise. Turn off if ORBIT misses quiet speech.')), ns),
      h('li', {}, h('span', { class: 'grow' }, 'Wait after I stop talking', h('div', { class: 'muted' }, 'Longer lets you pause mid-sentence without being cut off.')), patience)));
  S.cleanupMic?.(); S.cleanupMic = off;
  return panelEl;
}

// Voice gallery for the desktop app: built-in voices, downloadable natural voices, and cloud voices.
function voicePicker(rate, save) {
  const box = h('div', { class: 'stack' });
  const sample = "Good evening. I've dimmed the lights and your music is playing. Anything else?";
  const draw = async () => {
    const { current, voices, cloud = [] } = await native.voices();
    const groups = [['built-in', 'Built in'], ['natural', 'Most natural (one 100 MB download for all 11)'], ['download', 'High quality']];
    const item = (v) => {
      const use = h('button', { class: `btn small ${v.id === current ? 'primary' : ''}`, disabled: v.kind === 'cloud' && !v.installed }, v.id === current ? 'In use' : v.installed || v.kind === 'cloud' ? 'Use' : `Download ${v.sizeMB} MB`);
      use.addEventListener('click', async () => {
        use.disabled = true; use.textContent = v.installed ? 'Loading…' : 'Downloading…';
        S.voiceDownload = v.id;
        try {
          const r = await native.setVoice(v.id);
          toast(r.slow ? `${v.label} is set, but this computer generates it slowly, so replies may pause. A built-in voice will be smoother here.` : `ORBIT now speaks as ${v.label}.`, r.slow ? 'warn' : '');
          voice.say(sample);
        } catch (e) { toast(e.message.replace(/^Error invoking remote method '\w+': (Error: )?/, ''), 'bad'); }
        S.voiceDownload = null; draw();
      });
      const preview = h('button', { class: 'btn small ghost', 'aria-label': `Preview ${v.label}`, disabled: !(v.installed && v.id === current) }, 'Preview');
      preview.addEventListener('click', () => { voice.interrupt('preview'); voice.say(sample); });
      return h('li', {}, h('span', { class: 'grow' }, h('b', {}, v.label), h('div', { class: 'muted' }, v.desc)), v.id === current ? preview : null, use);
    };
    box.replaceChildren(panel('Voice',
      h('p', { class: 'muted' }, 'Built-in and downloaded voices run entirely on this computer. Cloud voices (Azure, Cartesia, Hume, OpenAI) sound the most human and need that service\'s key; if a cloud voice fails or its allowance runs out, ORBIT keeps talking with your last on-device voice.'),
      ...groups.map(([kind, title]) => { const vs = voices.filter((v) => v.kind === kind); return vs.length ? h('div', {}, h('div', { class: 'label' }, title), h('ul', { class: 'list' }, vs.map(item))) : null; }),
      ...cloud.map((g) => h('div', {}, h('div', { class: 'label' }, `${g.label} · cloud`),
        g.locked ? h('ul', { class: 'list' }, h('li', {}, h('span', { class: 'grow muted' }, `Add ${/^[AEIOU]/.test(g.label) ? "an" : "a"} ${g.label} key to use these voices.`), h('button', { class: 'btn small', onclick: () => go('ai') }, 'Add key')))
        : g.error ? h('p', { class: 'error-text' }, g.error)
        : h('ul', { class: 'list' }, g.voices.slice(0, 30).map((v) => item({ ...v, kind: 'cloud', installed: true, desc: v.desc || g.label }))))),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'v-rate' }, 'Speaking speed'), rate),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { await save(); voice.interrupt('preview'); voice.say(sample); } }, 'Save speed and preview'))));
  };
  native.on('voice-download', ({ fraction }) => { const b = [...box.querySelectorAll('button')].find((x) => x.textContent.startsWith('Downloading')); if (b) b.textContent = `Downloading ${Math.round(fraction * 100)}%`; });
  draw();
  return box;
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
    const modeBtn = (m, label) => h('button', { type: 'button', role: 'radio', 'aria-checked': String((S.mode || 'chat') === m), class: `btn small ${(S.mode || 'chat') === m ? 'primary' : ''}`, onclick: () => { S.mode = m; render(); } }, label);
    return h('div', { class: 'stack' },
      h('div', { class: 'row' },
        h('div', { class: 'row', role: 'radiogroup', 'aria-label': 'Mode' }, modeBtn('chat', 'Chat'), modeBtn('code', 'Code')),
        h('span', { class: 'muted' }, S.mode === 'code' ? 'Coding session: ORBIT plans, writes files in ORBIT Workspace, runs and tests them.' : 'Ask anything. Tasks like "create me a website" use your computer automatically.'),
        h('button', { class: 'btn small', style: null, onclick: () => { S.chat = []; send({ type: 'new-session' }); render(); } }, 'New session')),
      panel(S.mode === 'code' ? 'Coding session' : 'This session', box));
  },

  devices() {
    const o = S.overview;
    const codeBox = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Generate a one-time code, then run the Companion on the device you want ORBIT to control.'),
      h('button', { class: 'btn primary', onclick: async () => {
        const { code, expiresAt } = await api('POST', '/api/devices/pairing-code');
        codeBox.replaceChildren(h('div', { class: 'code' }, code), h('p', { class: 'muted' }, `Valid until ${new Date(expiresAt).toLocaleTimeString()}. On the device run:`),
          h('pre', { class: 'cmd' }, `node companion/agent.js pair ${location.origin} ${code} "My laptop"\nnode companion/agent.js`));
      } }, 'Pair a new device'));
    const phoneBox = h('div', { class: 'stack' });
    const drawPhones = async () => {
      const [acc, list] = await Promise.all([api('GET', '/api/phone/access'), api('GET', '/api/phones')]);
      const sw = h('button', { class: 'switch', role: 'switch', 'aria-label': 'Phone access on this Wi-Fi', 'aria-checked': String(acc.on) });
      sw.addEventListener('click', async () => { await api('POST', '/api/phone/access', { on: !acc.on }); drawPhones(); });
      const online = location.protocol === 'https:'; // on a server with its own https address, phones use that address
      const pair = h('button', { class: 'btn primary', disabled: !acc.on && !online }, 'Pair a phone');
      const out = h('div', {});
      pair.addEventListener('click', async () => {
        const r = await api('POST', '/api/phone/code');
        if (online) r.urls = [location.origin]; // on a server with its own https address, that's the one phones use
        else if (!r.urls.length) r.urls = [location.origin];
        out.replaceChildren(
          h('ol', { class: 'md-list' },
            online ? null : h('li', {}, 'Connect your phone to the same Wi-Fi as this PC.'),
            h('li', {}, 'Open this address in your phone\'s browser: ', ...r.urls.map((u, i) => [i ? ' or ' : '', h('b', { class: 'mono' }, u)])),
            h('li', {}, 'Type this code: ', h('span', { class: 'code' }, r.code)),
            h('li', {}, 'Add it to your home screen: iPhone: Share › Add to Home Screen. Android: ⋮ › Add to Home screen / Install app.')),
          h('p', { class: 'muted' }, `This code only works on ${r.urls[0]} (the ORBIT you're using now, not the desktop app or another server). It works once and expires at ${new Date(r.expiresAt).toLocaleTimeString()}.`));
      });
      phoneBox.replaceChildren(
        online ? h('p', { class: 'muted' }, `This ORBIT has its own secure address (${location.origin}), so phones can pair from anywhere; no Wi-Fi setting needed.`)
          : h('div', { class: 'perm' }, h('span', {}, 'Allow phones on this Wi-Fi', h('div', { class: 'muted' }, 'Off by default. Only paired phones can use ORBIT. When Windows asks, allow ORBIT on Private networks, and make sure your Wi-Fi is set to Private (not Public).')), sw),
        pair, out,
        list.length ? h('ul', { class: 'list' }, list.map((p) => h('li', {}, h('span', { class: 'grow' }, h('b', {}, p.name), h('div', { class: 'muted mono' }, `paired ${ago(p.createdAt)} ago · last used ${ago(p.lastSeen)}`)),
          h('button', { class: 'btn small danger', onclick: async () => { await api('DELETE', `/api/phones/${p.id}`); drawPhones(); } }, 'Remove')))) : null,
        h('p', { class: 'muted' }, 'Voice on the phone needs a secure (https) link, which phones require for the microphone. Typing works on Wi-Fi as is; see Phone app in the guide for voice and use away from home.'));
    };
    drawPhones();
    return h('div', { class: 'grid2' },
      panel('Pair', codeBox),
      panel('Phone app', phoneBox),
      panel('Your devices', o.devices.length ? h('ul', { class: 'list' }, o.devices.map((d) => h('li', {},
        h('span', { class: `dot ${d.online ? 'on' : ''}` }),
        h('span', { class: 'grow' }, h('b', {}, d.name), h('div', { class: 'muted mono' }, `${d.platform} · ${d.online ? 'online' : `seen ${ago(d.lastSeen)}`}${d.status?.battery != null ? ` · ${d.status.battery}%` : ''}${d.status?.cpu != null ? ` · cpu ${d.status.cpu}%` : ''}`)),
        h('button', { class: 'btn small', onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking…';
          const r = await api('POST', `/api/devices/${d.id}/check`).catch((err) => ({ ok: false, steps: [{ name: 'Check', ok: false, message: err.message }] }));
          b.disabled = false; b.textContent = 'Check';
          toast(h('div', {}, h('b', {}, r.ok ? `${d.name} is working.` : `${d.name} has a problem.`), h('ul', { class: 'list' }, r.steps.map((st) => h('li', {}, h('span', { class: `tag ${st.ok ? 'ok' : 'bad'}` }, st.ok ? 'ok' : 'fix'), h('span', { class: 'grow', title: st.message }, `${st.name}: ${st.message}`))))), r.ok ? '' : 'bad', [h('button', { class: 'btn small' }, 'Close')]);
        } }, 'Check'),
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
        (() => {
          const sel = h('select', { id: 'stt', 'aria-label': 'Speech recognition' },
            h('option', { value: 'device' }, 'On this computer (private)'),
            h('option', { value: 'groq:whisper-large-v3-turbo' }, 'Groq Whisper large v3 turbo (fast, more accurate)'),
            h('option', { value: 'groq:whisper-large-v3' }, 'Groq Whisper large v3 (most accurate)'));
          native.getInfo().then((i) => { sel.value = i.stt || 'device'; note.textContent = i.hasGroq ? '' : 'Groq options need a Groq key (free tier available) under AI configuration.'; });
          const note = h('div', { class: 'muted' });
          sel.addEventListener('change', async () => { await native.setStt(sel.value); toast(sel.value === 'device' ? 'Speech recognition stays on this computer.' : 'Your spoken commands will be transcribed by Groq. "Hey Orbit" is still detected on this computer.'); });
          return h('li', {}, h('span', { class: 'grow' }, 'Speech recognition', h('div', { class: 'muted' }, 'Groq Whisper understands names, accents and noisy rooms better. Only what you say after "Hey Orbit" is sent; if Groq is unavailable ORBIT uses the on-device result.'), note), sel);
        })(),
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
      native ? micPanel() : null,
      native ? voicePicker(rate, save) : null,
      native ? null : panel('Voice',
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'v-name' }, 'Voice'), vSel),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'v-rate' }, 'Speaking speed'), rate),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'v-pitch' }, 'Pitch'), pitch),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: save }, 'Save'), h('button', { class: 'btn', onclick: async () => { await save(); voice.say("Good evening. I'm here. What can I do for you?"); } }, 'Preview'))));
  },

  ai() {
    const o = S.overview, st = o.settings;
    const wrap = h('div', { class: 'stack' });
    const name = h('input', { id: 'ai-user', value: st.userName, placeholder: 'Alex' });
    const tone = h('select', { id: 'ai-tone' }, ['composed', 'concise', 'warm', 'witty', 'formal'].map((t) => h('option', { value: t, selected: t === st.tone }, t)));
    const instr = h('textarea', { id: 'ai-instr', rows: '4', placeholder: 'Anything ORBIT should always do or avoid' });
    instr.value = st.customInstructions || '';
    S.modelsReady = api('GET', '/api/ai/models').then((l) => { S.modelLists = l; }).catch(() => {});
    api('GET', '/api/ai/providers').then((P) => {
      const keys = o.aiKeys || [];
      const entries = Object.entries(P);
      const prov = h('select', { id: 'k-prov' },
        h('optgroup', { label: 'AI models' }, entries.filter(([, p]) => p.kind !== 'voice').map(([id, p]) => h('option', { value: id }, p.label))),
        h('optgroup', { label: 'Voices' }, entries.filter(([, p]) => p.kind === 'voice').map(([id, p]) => h('option', { value: id }, p.label))));
      const label = h('input', { id: 'k-label', placeholder: 'Work key' });
      const key = h('input', { id: 'k-key', type: 'password', autocomplete: 'off' });
      const base = h('input', { id: 'k-base', placeholder: 'https://example.com/v1' });
      const baseLabel = h('label', { class: 'label', for: 'k-base' }, 'API base URL');
      const baseField = h('div', { class: 'field' }, baseLabel, base);
      const help = h('a', { target: '_blank', rel: 'noopener' }, 'Get a key');
      const noteEl = h('p', { class: 'muted' });
      const sync = () => { const p = P[prov.value]; noteEl.textContent = p.note || ''; key.placeholder = p.keyHint; baseField.hidden = !p.needsBaseUrl && !p.extra; baseLabel.textContent = p.extra ? p.extra.label : 'API base URL'; base.placeholder = p.extra ? p.extra.placeholder : 'https://example.com/v1'; help.hidden = !p.keysUrl; help.href = p.keysUrl || '#'; };
      prov.addEventListener('change', sync); sync();
      const add = async () => {
        try { await api('POST', '/api/ai/keys', { provider: prov.value, label: label.value, key: key.value, baseUrl: base.value }); key.value = label.value = ''; toast('Key added.'); await refresh(); }
        catch (e) { toast(e.message, 'bad'); }
      };
      const row = (k) => {
        const status = !k.enabled ? h('span', { class: 'tag' }, 'off') : k.coolingDown ? h('span', { class: 'tag bad', title: k.lastError || '' }, 'paused') : k.lastError ? h('span', { class: 'tag bad', title: k.lastError }, 'error') : h('span', { class: 'tag ok' }, k.uses ? 'working' : 'ready');
        const test = h('button', { class: 'btn small', onclick: async () => {
          test.disabled = true; test.textContent = 'Testing…';
          const r = await api('POST', `/api/ai/keys/${k.id}/test`).catch((e) => ({ ok: false, error: e.message }));
          toast(r.ok ? `${k.label}: works (${r.model}, ${r.ms} ms)` : `${k.label}: ${r.error}`, r.ok ? '' : 'bad'); refresh();
        } }, 'Test');
        return h('li', {}, status,
          h('span', { class: 'grow' }, h('b', {}, k.label), h('div', { class: 'muted mono' }, `${k.providerLabel} · ${k.last4 ? `••••${k.last4}` : 'no key needed'} · used ${k.uses}×${k.failures ? ` · ${k.failures} failed` : ''}`)),
          test,
          h('button', { class: 'switch', role: 'switch', 'aria-label': `Use ${k.label}`, 'aria-checked': String(k.enabled), onclick: async () => { await api('PATCH', `/api/ai/keys/${k.id}`, { enabled: !k.enabled }); refresh(); } }),
          h('button', { class: 'btn small danger', 'aria-label': `Remove ${k.label}`, onclick: async () => { if (confirm(`Remove ${k.label}?`)) { await api('DELETE', `/api/ai/keys/${k.id}`); refresh(); } } }, 'Remove'));
      };
      const routeFields = (tier, title) => {
        const r = o.brain.routes[tier];
        const hasKey = (id) => keys.some((k) => k.enabled && k.provider === id);
        const sel = h('select', { id: `r-${tier}`, 'aria-label': `${title} provider` }, Object.entries(P).filter(([, p]) => p.kind !== 'voice').map(([id, p]) => h('option', { value: id, selected: id === r.provider }, hasKey(id) ? p.label : `${p.label} (no key yet)`)));
        const pickModel = h('select', { id: `ms-${tier}`, 'aria-label': `${title} model` });
        const model = h('input', { id: `m-${tier}`, 'aria-label': `${title} custom model name`, placeholder: 'exact model name' });
        const fill = (keepCurrent) => {
          const live = S.modelLists?.[sel.value]?.models || [];
          const def = P[sel.value].models[tier];
          const ids = [...new Set([def, ...live].filter(Boolean))];
          const cur = keepCurrent ? (r.model || def) : def;
          if (cur && !ids.includes(cur)) ids.unshift(cur);
          const isLive = S.modelLists?.[sel.value]?.source === 'live';
          pickModel.replaceChildren(...ids.map((m) => h('option', { value: m, selected: m === cur }, isLive && !S.modelLists[sel.value].models.includes(m) ? `${m} (not available)` : m === def ? `${m} (recommended)` : m)), h('option', { value: '__custom' }, 'Other…'));
          model.hidden = true;
        };
        sel.addEventListener('change', () => fill(false));
        pickModel.addEventListener('change', () => { model.hidden = pickModel.value !== '__custom'; if (!model.hidden) model.focus(); });
        fill(true);
        S.modelsReady.then(() => fill(true));
        return { sel, get model() { return { value: pickModel.value === '__custom' ? model.value : pickModel.value }; }, el: h('div', { class: 'field' }, h('span', { class: 'label' }, title), h('div', { class: 'row' }, sel, pickModel), model) };
      };
      const fast = routeFields('fast', 'Fast answers'), deep = routeFields('reasoning', 'Deep reasoning, code, screenshots');
      const fb = h('button', { class: 'switch', role: 'switch', 'aria-label': 'Fall back to other providers', 'aria-checked': String(o.brain.fallback) });
      fb.addEventListener('click', () => fb.setAttribute('aria-checked', String(fb.getAttribute('aria-checked') !== 'true')));
      wrap.replaceChildren(
        h('div', { class: 'grid2' },
          panel(`API keys (${keys.length})`,
            h('p', { class: 'muted' }, 'Add as many keys as you like, for AI models and for voices. ORBIT rotates through keys of the same provider and, when one is rate-limited or fails, moves to the next key automatically. Keys are encrypted on this computer and only the last 4 characters are ever shown.'),
            keys.length ? h('ul', { class: 'list' }, keys.map(row)) : empty('No keys yet. Device control, routines and memory work without one.')),
          panel('Add a key',
            h('div', { class: 'field' }, h('label', { class: 'label', for: 'k-prov' }, 'Provider'), prov),
            h('div', { class: 'field' }, h('label', { class: 'label', for: 'k-key' }, 'API key'), key),
            baseField,
            h('div', { class: 'field' }, h('label', { class: 'label', for: 'k-label' }, 'Name (optional)'), label),
            noteEl,
            h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: add }, 'Add key'), help))),
        h('div', { class: 'grid2' },
          panel('Which AI answers',
            (o.brain.unavailable || []).length ? h('p', { class: 'error-text' }, `Your chosen ${o.brain.unavailable.map((t) => (t === 'fast' ? 'quick-answer' : 'deep-reasoning')).join(' and ')} model isn't in that provider's current list (renamed, retired or not on your plan). Pick another below.`) : null,
            fast.el, deep.el,
            h('div', { class: 'perm' }, h('span', {}, 'If those keys fail, use my other providers'), fb),
            h('button', { class: 'btn primary', onclick: async () => {
              try { S.overview.brain = await api('PATCH', '/api/ai/routes', { fast: { provider: fast.sel.value, model: fast.model.value }, reasoning: { provider: deep.sel.value, model: deep.model.value }, fallback: fb.getAttribute('aria-checked') === 'true' }); updateChip(); toast('Saved.'); }
              catch (e) { toast(e.message, 'bad'); }
            } }, 'Save')),
          panel('Personality',
            h('div', { class: 'field' }, h('label', { class: 'label', for: 'ai-user' }, 'What should ORBIT call you?'), name),
            h('div', { class: 'field' }, h('label', { class: 'label', for: 'ai-tone' }, 'Tone'), tone),
            h('div', { class: 'field' }, h('label', { class: 'label', for: 'ai-instr' }, 'Your instructions for ORBIT'), instr, h('div', { class: 'muted' }, 'Added to every conversation, e.g. "Be blunt", "Skip disclaimers", "Answer in British English". How much a model follows them depends on the model.')),
            h('button', { class: 'btn primary', onclick: async () => { S.overview.settings = await api('PATCH', '/api/settings', { userName: name.value, tone: tone.value, customInstructions: instr.value }); toast('Saved.'); } }, 'Save'))));
    }).catch((e) => wrap.replaceChildren(empty(e.message)));
    return wrap;
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
      panel('This device',
        h('p', { class: 'muted' }, 'Sign out of ORBIT on this browser or phone. To use it again you\'ll need a new pairing code (or the access token).'),
        h('button', { class: 'btn danger', onclick: () => { if (!confirm('Sign out on this device?')) return; try { localStorage.removeItem('orbit.token'); } catch {} location.hash = 'dashboard'; location.reload(); } }, 'Sign out')),
      panel('Full control',
        h('div', { class: 'perm' }, h('span', {}, 'Let the AI run commands and edit files anywhere without asking', h('div', { class: 'muted' }, 'Off (recommended): ORBIT asks before every command or file change, and only uses ORBIT Workspace, Documents and Desktop. On: it acts on its own, in any folder. Everything is still recorded in the audit log below.')),
          (() => { const b = h('button', { class: 'switch', role: 'switch', 'aria-label': 'Full control', 'aria-checked': String(!!o.settings.fullControl) }); b.addEventListener('click', async () => {
            const on = b.getAttribute('aria-checked') !== 'true';
            if (on && !confirm('Give the AI full control of this computer? It will run commands and change files anywhere without asking.')) return;
            S.overview.settings = await api('PATCH', '/api/settings', { fullControl: on }); b.setAttribute('aria-checked', String(on)); toast(on ? 'Full control is on.' : 'ORBIT will ask before acting.');
          }); return b; })())),
      panel('Data', h('p', { class: 'muted' }, 'API keys live only in the server .env. The dashboard uses a separate access token. Device credentials are stored hashed and can be revoked at any time. Screenshots are analysed in memory and never written to the server.')),
      panel('Audit log', log));
  },
};

function renderChat() {
  const box = $('#chat'); if (!box) return;
  const msgs = S.chat.map((m) => {
    if (m.role === 'user') return h('div', { class: 'msg user' }, m.text);
    if (m.role === 'note') return h('div', { class: 'msg note' }, ...md(m.text));
    if (m.role === 'tool') return h('details', { class: `tool-step ${m.status}` },
      h('summary', {}, h('span', { class: `tag ${m.status === 'ok' ? 'ok' : m.status === 'failed' ? 'bad' : ''}` }, m.status === 'running' ? '…' : m.status === 'ok' ? '✓' : '✕'), ' ', m.summary || m.name),
      m.output ? h('pre', { class: 'cmd' }, m.output) : null);
    if (m.role === 'approve') return h('div', { class: 'approve-card', role: 'group', 'aria-label': 'Approval needed' },
      h('b', {}, m.state === 'pending' ? 'ORBIT wants to:' : m.state === 'denied' ? 'Declined:' : 'Approved:'), ' ', m.summary,
      m.detail ? h('details', {}, h('summary', {}, 'Details'), h('pre', { class: 'cmd' }, m.detail)) : null,
      m.state === 'pending' ? h('div', { class: 'row' },
        h('button', { class: 'btn small primary', onclick: () => answerApproval(m.id, true) }, 'Approve'),
        h('button', { class: 'btn small', onclick: () => answerApproval(m.id, true, true) }, 'Allow for this session'),
        h('button', { class: 'btn small danger', onclick: () => answerApproval(m.id, false) }, 'Deny')) : null);
    return h('div', { class: 'msg orbit' }, ...md(m.text), m.ms != null ? h('div', { class: 'muted mono' }, `${m.route || 'local'} · ${(m.ms / 1000).toFixed(1)} s`) : null);
  });
  if (S.live) msgs.push(h('div', { class: 'msg orbit' }, ...md(S.live)));
  else if (S.pending) msgs.push(h('div', { class: 'msg orbit pending', role: 'status' }, pendingText()));
  box.replaceChildren(...(msgs.length ? msgs : [empty(S.mode === 'code' ? 'Describe what to build, e.g. "a to-do app in React" or "fix the error in my script".' : 'No conversation yet in this session.')]));
  box.lastElementChild?.scrollIntoView({ block: 'end' });
}

function render() {
  if (!S.overview) return;
  $('#view-title').textContent = NAV.find((n) => n[0] === S.view)[1];
  if (S.view !== 'dashboard') core = null;
  $('#view').replaceChildren(VIEWS[S.view]());
}

function start() {
  $('#login').hidden = true; $('#app').hidden = false;
  const wanted = location.hash.slice(1).split('?')[0];
  S.view = NAV.some((n) => n[0] === wanted) ? wanted : 'dashboard';
  buildNav(); mini = new Core($('#core-mini'), { mini: true });
  connect();
}

if ('serviceWorker' in navigator && !window.orbitNative && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) navigator.serviceWorker.register('sw.js').catch(() => {});
S.token = new URLSearchParams(location.hash.split('?')[1] || '').get('token') || getToken();
if (S.token) api('GET', '/api/overview').then(() => { setToken(S.token); start(); }).catch(() => {}); else showLogin();
speechSynthesis?.addEventListener?.('voiceschanged', () => { if (S.view === 'voice') render(); });
