// ORBIT projector (JARVIS mode): black, a small orb, voice only. Projects answers and anything
// ORBIT is asked to show, then fades back to the orb. Needs an AI key before it listens.
import { Core } from './core.js';
import { createVoice, inQuietHours } from './voice.js';
import { createRemoteSpeech } from './remote-speech.js';

const $ = (s) => document.querySelector(s);
const token = new URLSearchParams(location.hash.split('?')[1] || location.hash.slice(1)).get('token') || '';
const api = (method, path, body) => fetch(path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const core = new Core($('#orb'), { mini: true });
let ws, voice, live = '', streamed = false, pendingApproval = null, cardTimer, idleTimer, settings = {};

// ---- safe mini-markdown for projected text (no HTML injected) ----
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function render(md) {
  const out = [];
  const parts = String(md).split(/```[\w+-]*\n?([\s\S]*?)(?:```|$)/g);
  parts.forEach((part, i) => {
    if (i % 2) { out.push(el('pre', null, part.replace(/\n$/, ''))); return; }
    // Line by line: headings, list items (grouped) and paragraphs.
    let list = null, para = [];
    const endPara = () => { if (para.length) out.push(el('p', null, para.join(' ').replace(/\*\*|`/g, ''))); para = []; };
    for (const line of part.split('\n')) {
      if (/^\s*([-*•]|\d+\.)\s+/.test(line)) { endPara(); if (!list) { list = el('ul'); out.push(list); } list.append(el('li', null, line.replace(/^\s*([-*•]|\d+\.)\s+/, '').replace(/\*\*|`/g, ''))); continue; }
      list = null;
      if (/^#{1,4}\s/.test(line)) { endPara(); out.push(el('div', 'h', line.replace(/^#+\s*/, '').replace(/\*\*/g, ''))); }
      else if (!line.trim()) endPara();
      else para.push(line.trim());
    }
    endPara();
  });
  return out;
}
function showCard(nodes, { seconds = 25, cls = '' } = {}) {
  const card = $('#card'); card.className = `card ${cls}`; card.replaceChildren(...nodes); card.hidden = false;
  document.body.classList.add('has-card');
  clearTimeout(cardTimer); if (seconds) cardTimer = setTimeout(hideCard, seconds * 1000);
}
function hideCard() { $('#card').hidden = true; document.body.classList.remove('has-card'); }
const caption = (t) => { $('#caption').textContent = t || ''; };
// Long or structured answers are projected; short ones are only spoken.
const worthShowing = (t) => t.length > 160 || /```|\n\s*[-*•\d]/.test(t);

function setState(s) {
  core.setState(s); document.body.classList.toggle('busy', s !== 'idle');
  Core.paused = false; clearTimeout(idleTimer);
  if (s === 'idle') idleTimer = setTimeout(() => { Core.paused = true; }, 120000); // rest the GPU when nothing happens
}

// ---- setup: an AI key first ----
async function needsKey() { try { const o = await api('GET', '/api/overview'); return o.brain?.provider === 'offline'; } catch { return true; } }
async function setupLoop() {
  document.body.classList.add('setup-mode'); $('#setup').hidden = false; setState('idle');
  const net = await api('GET', '/api/network').catch(() => ({ urls: [] }));
  if (net.urls?.length) $('#setup-url').textContent = ['http://orbit.local:7777', ...net.urls].slice(0, 2).join('  or  ');
  const refreshCode = async () => { const r = await api('POST', '/api/phone/code').catch(() => null); if (r?.code) $('#setup-code').textContent = r.code; };
  await refreshCode();
  const codeTimer = setInterval(refreshCode, 9 * 60 * 1000);
  while (await needsKey()) await new Promise((r) => setTimeout(r, 4000));
  clearInterval(codeTimer);
  $('#setup').hidden = true; document.body.classList.remove('setup-mode');
  caption('Ready. Say "Hey Orbit".'); setTimeout(() => caption(''), 6000);
}

// ---- live connection and voice ----
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/ui?token=${encodeURIComponent(token)}`);
  ws.onmessage = (ev) => onEvent(JSON.parse(ev.data));
  ws.onclose = () => { remote.reset(); setState('error'); setTimeout(connect, 2000); };
  ws.onopen = async () => {
    setState('idle'); voice?.setMode('wake');
    const o = await api('GET', '/api/overview').catch(() => null); if (o) settings = o.settings || {};
    send({ type: 'client-info', room: settings.projectorRoom || 'Desk', voice: true });
  };
}
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
const remote = createRemoteSpeech({ ws: () => ws, send });

function onEvent(m) {
  switch (m.type) {
    case 'speech': case 'speech-tts': remote.event(m); break;
    case 'state': setState(m.state === 'listening-ready' ? 'idle' : m.state); break;
    case 'thinking': caption('Thinking…'); break;
    case 'delta': streamed = true; live += m.text; voice.feed(m.text); caption(''); break;
    case 'done': {
      const text = m.text ?? live; live = '';
      if (m.answeredElsewhere) { setState('idle'); break; } // a device closer to you answered
      if (streamed) voice.flush(); else if (text) voice.say(text); // instant local answers aren't streamed
      streamed = false;
      if (text && worthShowing(text)) { caption(''); showCard(render(text), { seconds: Math.min(90, 15 + text.length / 25) }); }
      else if (text) { caption(text); setTimeout(() => { if ($('#caption').textContent === text) caption(''); }, 12000); }
      setState(m.ok === false ? 'error' : 'idle');
      break;
    }
    case 'tool': if (m.status === 'running') caption(m.summary || ''); else if (m.status === 'failed') caption(`Couldn't: ${m.summary || m.name}`); break;
    case 'approve':
      pendingApproval = m;
      showCard([el('div', 'h', 'ORBIT wants to:'), el('p', null, m.summary), el('p', 'say', 'Say "approve" or "deny".')], { seconds: 0, cls: 'approve' });
      voice.say(`I need your OK to ${m.summary.replace(/^Run:/, 'run').replace(/^Write/, 'write')}. Say approve or deny.`);
      break;
    case 'announce': { const t = `${m.from ? `From the ${m.from.toLowerCase()}: ` : ''}${m.text}`; caption(t); voice.say(t); setTimeout(() => caption(''), 15000); break; }
    case 'project': if (!m.content) { hideCard(); break; } showCard(render(m.content), { seconds: m.seconds || 60 }); break;
    case 'notify': caption(m.text); if (m.speak) voice.say(m.text); setTimeout(() => caption(''), 10000); break;
    case 'error': caption(m.message); break;
  }
}

function onUtterance(text) {
  const t = text.toLowerCase().trim();
  if (pendingApproval) {
    const yes = /^(yes|yeah|approve[d]?|do it|go ahead|ok(ay)?|sure|allow)\b/.test(t), no = /^(no|nope|deny|denied|cancel|stop|don't)\b/.test(t);
    if (yes || no) { send({ type: 'approve', id: pendingApproval.id, ok: yes, spoken: true }); pendingApproval = null; hideCard(); voice.say(yes ? 'Approved.' : 'Okay, I won\'t.'); return; }
  }
  if (/^(hide|clear|close)( it| that| the (screen|projector|display))?$/.test(t)) { hideCard(); voice.say('Done.'); return; }
  live = ''; streamed = false; caption(`“${text}”`);
  send({ type: 'utterance', text, source: 'voice' });
}

// ---- ambient clock / weather / next reminder ----
let amb = null;
async function ambient() {
  const tick = () => {
    const now = new Date();
    $('#amb-time').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const bits = [];
    if (amb?.weather) bits.push(`${amb.weather.temp}° ${amb.weather.text}`);
    if (amb?.next) bits.push(`Next: ${amb.next.text} at ${new Date(amb.next.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    $('#amb-line').textContent = bits.join('  ·  ');
    document.body.classList.toggle('quiet', inQuietHours(settings.quietHours));
  };
  const load = async () => { amb = await api('GET', '/api/ambient').catch(() => amb); const o = await api('GET', '/api/overview').catch(() => null); if (o) settings = o.settings || settings; tick(); };
  await load(); setInterval(tick, 20000); setInterval(load, 5 * 60000);
}

(async () => {
  if (!token) { caption('Missing access token.'); return; }
  if (await needsKey()) await setupLoop();
  voice = createVoice(remote);
  voice.quiet = () => inQuietHours(settings.quietHours);
  ambient();
  voice.addEventListener('state', (e) => setState(e.detail === 'listening-ready' ? 'idle' : e.detail));
  voice.addEventListener('level', (e) => core.setLevel(e.detail));
  voice.addEventListener('interim', (e) => caption(e.detail));
  voice.addEventListener('utterance', (e) => onUtterance(e.detail.text));
  voice.addEventListener('interrupt', () => send({ type: 'interrupt' }));
  voice.addEventListener('error', (e) => caption(e.detail));
  connect();
})();
