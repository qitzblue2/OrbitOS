// Aphelion toolbar UI. Everything that comes from websites (titles, URLs) is set with
// textContent, never innerHTML.
import { bgValue } from './shared/backgrounds.js';

const $ = (s) => document.querySelector(s);
const call = (name, ...a) => window.aph.call(name, ...a);
let S = null;            // last state from the main process
let popName = null;      // open popover
let popTimer = null;
let addrDirty = false;
const tabEls = new Map();

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const svg = (d, fill = false) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  s.append(p);
  if (fill) s.style.fill = 'currentColor';
  return s;
};
const sw = (on, onClick, label) => h('button', { class: 'switch', role: 'switch', 'aria-checked': String(Boolean(on)),
                                                  'aria-label': label, onclick: onClick });
const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

// ---------------------------------------------------------------- state
window.aph.on('state', (s) => {
  S = s;
  render();
});
window.aph.on('focus', (what) => {
  if (what === 'address') {
    const a = $('#addr');
    a.focus();
    a.select();
  }
  if (what === 'find') $('#find-input')?.focus();
});
window.aph.on('event', (name, payload) => {
  if (name === 'downloads' && popName === 'dl') renderPop();
});
call('state').then((s) => {
  S = s;
  render();
});

function render() {
  const b = document.body;
  const u = S.ui;
  b.className = [`style-${u.style.toLowerCase()}`, u.reduce && 'reduce', u.compact && 'compact', u.contrast && 'contrast',
                 u.motion && 'motion', u.bigtext && 'bigtext', S.private && 'private'].filter(Boolean).join(' ');
  b.style.setProperty('--wall', S.private ? 'linear-gradient(135deg,#1d1430,#120a26 60%,#1a1a1d)' : bgValue(u.bg));
  $('#private-badge').hidden = !S.private;
  renderTabs();
  renderToolbar();
  renderBars();
  // the wallpaper stays behind the toolbar only: while a popover makes this view
  // cover the window, the page must stay visible underneath
  $('#bg').style.height = `${$('#bars').getBoundingClientRect().bottom}px`;
  const show = Boolean(S.overlay);
  $('#overlay').hidden = !show;
  if (show && popName !== S.overlay) openPop(S.overlay, false);
  if (!show && popName) {
    popName = null;
    $('#pop').replaceChildren();
  }
}

// ---------------------------------------------------------------- tabs
function renderTabs() {
  const wrap = $('#tabs');
  const ids = new Set(S.tabs.map((t) => t.id));
  for (const [id, el] of tabEls) {
    if (!ids.has(id) && !el.classList.contains('closing')) {
      el.classList.add('closing');
      setTimeout(() => {
        el.remove();
        tabEls.delete(id);
      }, 170);
    }
  }
  let prev = null;
  for (const t of S.tabs) {
    let el = tabEls.get(t.id);
    if (!el) {
      el = h('div', { class: 'tab', role: 'tab', draggable: 'true', tabindex: '0' },
             h('img', { class: 'fav', alt: '' }), h('span', { class: 'title' }), h('span', { class: 'sound' }),
             h('button', { class: 'x', 'aria-label': 'Close tab', text: '×' }));
      el.dataset.id = t.id;
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('x')) {
          e.stopPropagation();
          call('closeTab', t.id);
        } else call('selectTab', t.id);
      });
      el.addEventListener('auxclick', (e) => e.button === 1 && call('closeTab', t.id));
      el.addEventListener('keydown', (e) => e.key === 'Enter' && call('selectTab', t.id));
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/aph-tab', String(t.id));
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dragover', (e) => e.preventDefault());
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const id = Number(e.dataTransfer.getData('text/aph-tab'));
        if (id && id !== t.id) call('moveTab', id, S.tabs.findIndex((x) => x.id === t.id));
      });
      tabEls.set(t.id, el);
    }
    el.classList.toggle('active', t.active);
    el.classList.toggle('sleeping', t.sleeping);
    el.setAttribute('aria-selected', String(t.active));
    el.title = t.sleeping ? `${t.title} (sleeping)` : t.title;
    el.querySelector('.title').textContent = t.title;
    const fav = el.querySelector('.fav');
    if (t.loading) {
      if (!el.querySelector('.spin')) fav.replaceWith(h('span', { class: 'spin fav' }));
    } else {
      const cur = el.querySelector('.fav');
      if (cur.tagName !== 'IMG') cur.replaceWith(h('img', { class: 'fav', alt: '' }));
      const img = el.querySelector('.fav');
      if (t.favicon && img.getAttribute('src') !== t.favicon) {
        img.src = t.favicon;
        img.classList.add('img');
        img.onerror = () => {
          img.removeAttribute('src');
          img.classList.remove('img');
        };
      } else if (!t.favicon) {
        img.removeAttribute('src');
        img.classList.remove('img');
      }
    }
    el.querySelector('.sound').textContent = t.audible ? '♪' : '';
    if (el.previousElementSibling !== prev || el.parentElement !== wrap) {
      if (prev) prev.after(el);
      else wrap.prepend(el);
    }
    prev = el;
  }
  $('#winbtns [data-win=full]').title = S.fullscreen ? 'Exit full screen' : 'Full screen';
  $('#winbtns [data-win=full] path').setAttribute('d', S.fullscreen ? 'M2.5 5.5l3-3' : 'M2 2h4v4');
}

// ---------------------------------------------------------------- toolbar
function renderToolbar() {
  const n = S.nav;
  $('[data-nav=back]').disabled = !n.canBack;
  $('[data-nav=forward]').disabled = !n.canForward;
  $('#reload-path').setAttribute('d', n.loading ? 'M4 4l8 8M12 4l-8 8' : 'M13 8a5 5 0 1 1-1.6-3.7M13.2 2.5v2.4h-2.4');
  $('[data-nav=reload]').title = n.loading ? 'Stop (Esc)' : 'Reload (Ctrl+R)';
  const a = $('#addr');
  if (document.activeElement !== a || !addrDirty) {
    const shown = n.internal ? (n.url.startsWith('aphelion://newtab') ? '' : n.url) : n.url;
    if (a.value !== shown) a.value = shown;
  }
  const lock = $('#lock');
  lock.textContent = n.internal || !n.url ? '◎' : n.secure ? '🔒︎' : '⚠︎';
  lock.className = !n.internal && n.url && !n.secure ? 'warn' : '';
  lock.title = n.internal ? 'Aphelion page' : n.secure ? 'Secure connection (HTTPS)' : 'Not secure: this page does not use HTTPS';
  const star = $('#star');
  star.textContent = n.bookmarked ? '★' : '☆';
  star.classList.toggle('on', n.bookmarked);
  star.hidden = n.internal || !n.url;
  $('#reader').hidden = !n.reader;
  const z = $('#zoom');
  z.hidden = n.zoom === 100;
  z.textContent = `${n.zoom}%`;
  const wrap = $('#widgets');
  wrap.replaceChildren(...S.widgets.map((w) => h('button', { type: 'button', class: `widget${S.overlay === w.key ? ' open' : ''}`, title: w.title,
                                                             'aria-label': w.title, onclick: () => togglePop(w.key) },
                                                 w.icon, w.badge ? h('span', { class: 'badge', text: w.badge }) : null)));
  const shield = $('#shield');
  shield.classList.toggle('off', !S.shieldOnForSite);
  $('#blocked').textContent = String(n.internal ? 0 : S.counts.trackers);
}

$('#newtab').onclick = () => call('newTab');
for (const b of document.querySelectorAll('[data-win]')) b.onclick = () => call('win', b.dataset.win);
for (const b of document.querySelectorAll('[data-nav]')) {
  b.onclick = () => call('nav', b.dataset.nav === 'reload' && S?.nav.loading ? 'stop' : b.dataset.nav);
}
// drag the window by the empty strip area; tabs and buttons stay plain click targets
const isStripGap = (el) => el === $('#strip') || el === $('#tabs') || el.classList.contains('drag');
$('#strip').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !isStripGap(e.target) || e.detail > 1) return;
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  window.aph.drag('start', e.screenX, e.screenY);
  const move = (m) => window.aph.drag('move', m.screenX, m.screenY);
  const end = () => {
    window.aph.drag('end', 0, 0);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
});
$('#strip').addEventListener('dblclick', (e) => {
  if (isStripGap(e.target)) call('win', 'max');
});
$('#star').onclick = () => call('bookmark');
$('#reader').onclick = () => call('menu', 'reader');
$('#zoom').onclick = () => call('menu', 'zoomReset');
$('#shield').onclick = () => togglePop('shield');
$('#menu-btn').onclick = () => togglePop('menu');
$('#catcher').addEventListener('mousedown', () => closePop());

// address bar + suggestions
const addr = $('#addr');
let sugg = [];
let suggSel = -1;
let suggSeq = 0;
addr.addEventListener('focus', () => {
  setTimeout(() => addr.select(), 0);
  call('suggestWarm');
});
// local matches render at once; engine phrases are merged in when they arrive. While
// waiting, the previous phrases that still start with what is typed stay on screen.
let lastRemote = [];
const showSugg = (list) => {
  sugg = list;
  if (suggSel >= sugg.length) suggSel = -1;
  if (sugg.length) openPop('suggest');
  else if (popName === 'suggest') closePop();
  if (popName === 'suggest') renderPop();
};
const merge = (local, remote) => [...local, ...remote.filter((r) => !local.some((l) => l.url === r.url))].slice(0, 10);
addr.addEventListener('input', async () => {
  addrDirty = true;
  const q = addr.value;
  const seq = ++suggSeq;
  if (!q.trim()) {
    sugg = [];
    lastRemote = [];
    if (popName === 'suggest') closePop();
    return;
  }
  suggSel = -1;
  const lower = q.trim().toLowerCase();
  const local = await call('suggestLocal', q);
  if (seq !== suggSeq) return;
  showSugg(merge(local, lastRemote.filter((r) => r.title.toLowerCase().startsWith(lower))));
  const remote = await call('suggestRemote', q);
  if (seq !== suggSeq) return;
  lastRemote = remote;
  showSugg(merge(local, remote));
});
addr.addEventListener('keydown', (e) => {
  if (popName === 'suggest' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    suggSel = (suggSel + (e.key === 'ArrowDown' ? 1 : -1) + sugg.length + 1) % (sugg.length + 1) - 0;
    if (suggSel >= sugg.length) suggSel = -1;
    renderPop();
  }
  if (e.key === 'Escape') {
    addrDirty = false;
    addr.value = S.nav.url;
    closePop();
    addr.blur();
  }
});
$('#addr-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const pick = suggSel >= 0 ? sugg[suggSel] : null;
  addrDirty = false;
  closePop();
  call('navigate', pick ? pick.url : addr.value);
  addr.blur();
});
addr.addEventListener('blur', () => {
  setTimeout(() => {
    if (document.activeElement !== addr && popName === 'suggest') closePop();
  }, 150);
});

// ---------------------------------------------------------------- bars
function renderBars() {
  const wrap = $('#bars');
  const els = [];
  if (S.find) {
    const input = h('input', { id: 'find-input', type: 'text', placeholder: 'Find in page', value: S.find.text, spellcheck: 'false' });
    input.addEventListener('input', () => call('find', input.value, {}));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') call('find', input.value, { next: true, forward: !e.shiftKey });
      if (e.key === 'Escape') call('findClose');
    });
    const keep = document.getElementById('find-input');
    els.push(h('div', {}, keep || input,
      h('span', { class: 'count', text: S.find.text ? `${S.find.active}/${S.find.matches}` : '' }),
      h('button', { class: 'btn', text: '↑', title: 'Previous (Shift+Enter)', onclick: () => call('find', $('#find-input').value, { next: true, forward: false }) }),
      h('button', { class: 'btn', text: '↓', title: 'Next (Enter)', onclick: () => call('find', $('#find-input').value, { next: true }) }),
      h('span', { class: 'text' }), h('button', { class: 'btn', text: 'Done', onclick: () => call('findClose') })));
  }
  for (const bar of S.bars) {
    const remember = bar.remember ? h('input', { type: 'checkbox', checked: true }) : null;
    els.push(h('div', {}, h('span', { class: 'text', text: bar.text }),
      remember ? h('label', {}, remember, 'Remember') : null,
      ...bar.actions.map(([label, act], i) => h('button', {
        class: `btn${i === 0 ? ' primary' : ''}`, text: label,
        onclick: () => (bar.id === 'savepw' ? window.aph.savePending(act === 'save') : call('bar', bar.id, act, remember?.checked)),
      }))));
  }
  wrap.replaceChildren(...els);
}

// ---------------------------------------------------------------- popovers
function togglePop(name) {
  if (popName === name) closePop();
  else openPop(name);
}

function openPop(name, tell = true) {
  clearTimeout(popTimer);
  popName = name;
  $('#overlay').hidden = false;
  if (tell) call('popover', name);
  renderPop();
}

function closePop() {
  if (!popName) return;
  const pop = $('#pop').firstElementChild;
  const name = popName;
  popName = null;
  if (pop) pop.classList.add('closing');
  popTimer = setTimeout(() => {
    if (!popName) {
      $('#pop').replaceChildren();
      $('#overlay').hidden = true;
    }
  }, 160);
  if (name) call('popover', null);
}

function place(pop, anchor, align = 'right') {
  const r = (anchor || $('#toolbar')).getBoundingClientRect();
  const top = $('#toolbar').getBoundingClientRect().bottom + 6;
  pop.style.top = `${top}px`;
  if (align === 'left') {
    pop.style.left = `${r.left}px`;
    pop.style.width = `${r.width}px`;
  } else pop.style.right = `${Math.max(10, window.innerWidth - r.right)}px`;
}

const POPS = {
  menu: popMenu, shield: popShield, ads: popAds, auth: popAuth, kp: popKeePass, notes: popNotes, dl: popDownloads,
  media: popMedia, suggest: popSuggest,
};

let renderSeq = 0;
async function renderPop() {
  if (!popName) return;
  const fn = POPS[popName];
  if (!fn) return;
  const seq = ++renderSeq;
  const content = await fn();
  if (seq !== renderSeq || !popName) return;
  const old = $('#pop').firstElementChild;
  content.classList.add('pop');
  if (old && old.dataset.name === popName) content.style.animation = 'none';
  content.dataset.name = popName;
  const anchor = popName === 'menu' ? $('#menu-btn') : popName === 'shield' ? $('#shield')
    : popName === 'suggest' ? $('#addr-form') : $('#shield');
  place(content, anchor, popName === 'suggest' ? 'left' : 'right');
  $('#pop').replaceChildren(content);
  content.querySelector('[autofocus]')?.focus();
}

// ---- ⋯ menu
function popMenu() {
  const mac = S.platform === 'darwin';
  const k = (s) => (mac ? s.replace('Ctrl', '⌘') : s);
  const items = [['New tab', 'Ctrl T', 'newTab'], ['New window', 'Ctrl N', 'newWindow'], ['New private window', 'Ctrl ⇧ N', 'private'],
                 null, ['Bookmarks', 'Ctrl ⇧ O', 'bookmarks'], ['History', 'Ctrl H', 'history'], ['Downloads', 'Ctrl J', 'downloads'],
                 null, ['Find in page', 'Ctrl F', 'find'], ['Reader view', 'Ctrl Alt R', 'reader'], ['Hide an element…', '', 'picker'],
                 ['Print…', 'Ctrl P', 'print'], null, ['Zoom in', 'Ctrl +', 'zoomIn'], ['Zoom out', 'Ctrl −', 'zoomOut'],
                 null, ['Settings', 'Ctrl ,', 'settings'], ['Quit Aphelion', mac ? '⌘ Q' : '', 'quit']];
  return h('div', { style: { width: '260px', padding: '6px', gap: '0' }, role: 'menu' },
    ...items.map((it) => (it ? h('div', { class: 'item', role: 'menuitem', tabindex: '0', onclick: () => call('menu', it[2]),
                                          onkeydown: (e) => e.key === 'Enter' && call('menu', it[2]) },
                                h('span', { text: it[0] }), h('span', { class: 'key', text: k(it[1]) }))
                              : h('div', { class: 'sep' }))));
}

// ---- tracker shield
function popShield() {
  const n = S.counts.trackers;
  const on = S.shieldOnForSite;
  return h('div', { style: { width: '280px' } },
    h('h3', { text: 'Tracker shield' }),
    h('div', { class: 'muted', style: { lineHeight: '1.5' },
               text: S.nav.internal ? 'Aphelion pages never load trackers.' : `${n} tracker${n === 1 ? '' : 's'} blocked on this page.` }),
    S.nav.internal ? null : h('div', { class: 'row', onclick: () => call('shield') },
                              h('span', { text: `Protection for ${S.nav.host.replace(/^www\./, '')}` }), sw(on, null, 'Protection for this site')),
    h('div', { class: 'hint', text: 'Blocks tracking scripts, pixels and fingerprinting with the EasyPrivacy list. Turning it off reloads the page.' }));
}

// ---- ad blocker
async function popAds() {
  const info = await call('adsInfo');
  const filters = [['easy', 'EasyList (ads)'], ['annoy', 'Cookie banners & annoyances'], ['social', 'Social widgets']];
  return h('div', { style: { width: '300px' } },
    h('h3', {}, h('span', { text: 'Ad blocker' }), sw(info.on, () => call('setting', 'ads', !info.on).then(renderPop), 'Ad blocker')),
    h('div', { class: 'grid2' },
      h('div', { class: 'stat' }, h('b', { text: String(info.on ? info.page : 0) }), h('span', { text: 'on this page' })),
      h('div', { class: 'stat' }, h('b', { text: info.total.toLocaleString() }), h('span', { text: 'blocked this session' }))),
    h('div', { class: 'label', text: 'Filter lists' }),
    ...filters.map(([key, label]) => h('div', { class: 'row', onclick: () => call('setting', key, !info[key]).then(renderPop) },
                                       h('span', { text: label }), sw(info[key], null, label))),
    S.nav.internal ? null : h('div', { class: 'row', onclick: () => call('adsSite').then(renderPop) },
                              h('span', { class: 'muted', text: `Block ads on ${S.nav.host.replace(/^www\./, '')}` }),
                              sw(S.adsOnForSite, null, 'Block ads on this site')),
    h('button', { class: 'btn', style: { height: '34px' }, text: 'Pick element to hide', onclick: () => call('picker'),
                  disabled: S.nav.internal }));
}

// ---- authenticator
let authTimer = null;
let authCopied = null;
const errText = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
async function popAuth() {
  clearInterval(authTimer);
  const root = h('div', { style: { width: '320px' } });
  const state = await call('totpState');
  if (state !== 'open') {
    root.append(authLockScreen(state));
    return root;
  }
  // only the code list redraws every second; the header and the add form are built
  // once, so a form being filled in is never reset under the user's hands
  const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  const sub = h('span', { class: 'sub' });
  const hint = h('div', { class: 'hint' });
  root.append(
    h('h3', {}, h('span', { text: 'Authenticator' }),
      h('span', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, sub,
        h('span', { class: 'sub click', title: 'Lock the authenticator', text: 'Lock',
                    onclick: () => call('totpLock').then(() => renderPop()) }))),
    list, hint, addTotpForm());
  root._fill = (codes) => {
    const secs = codes[0]?.remaining ?? 30;
    const period = codes[0]?.period ?? 30;
    sub.textContent = codes.length ? `${secs}s` : '';
    hint.textContent = authCopied ? 'Code copied. It clears from the clipboard in 30 s.' : codes.length ? 'Click a code to copy it.' : '';
    list.replaceChildren(
      codes.length ? h('div', { class: 'bar' }, h('div', { class: secs < 6 ? 'urgent' : '', style: { width: `${(secs / period) * 100}%` } })) : '',
      ...codes.map((c) => h('div', { class: 'card click', style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                                                                    background: authCopied === c.id ? 'var(--row-active)' : '' },
                                    onclick: () => call('totpCopy', c.id).then(() => {
                                      authCopied = c.id;
                                      refreshAuth();
                                    }) },
        h('div', { class: 'grow' }, h('span', { style: { fontWeight: 500 }, text: c.name }), h('span', { class: 'sub', text: c.account })),
        h('span', { class: 'code', text: c.code.replace(/(\d{3})(?=\d)/, '$1 ') }))),
      codes.length ? '' : h('div', { class: 'empty', text: 'No accounts yet.' }));
  };
  root._fill(await call('totp'));
  authTimer = setInterval(() => (popName === 'auth' ? refreshAuth() : clearInterval(authTimer)), 1000);
  return root;
}
async function refreshAuth() {
  const root = $('#pop').firstElementChild;
  if (!root?._fill) return;
  try {
    root._fill(await call('totp'));
  } catch {
    clearInterval(authTimer);  // locked itself (idle, screen lock, sleep): show the password screen
    renderPop();
  }
}
// first use: choose a password; afterwards: unlock with it
function authLockScreen(state) {
  const setup = state === 'setup';
  const pw = h('input', { type: 'password', placeholder: setup ? 'New password (6+ characters)' : 'Password', autofocus: true });
  const pw2 = setup ? h('input', { type: 'password', placeholder: 'Repeat password' }) : null;
  const err = h('div', { class: 'err' });
  const btn = h('button', { class: 'btn primary', style: { height: '34px' }, text: setup ? 'Set password' : 'Unlock' });
  const form = h('form', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, pw, pw2, btn);
  form.onsubmit = (e) => {
    e.preventDefault();
    err.textContent = '';
    if (setup && pw.value !== pw2.value) {
      err.textContent = 'The passwords are not the same.';
      return;
    }
    btn.disabled = true;
    call(setup ? 'totpSetup' : 'totpUnlock', pw.value).then(() => renderPop()).catch((x) => {
      err.textContent = errText(x);
      btn.disabled = false;
      pw.select();
    });
  };
  setTimeout(() => pw.focus(), 0);
  return h('div', {},
    h('h3', {}, h('span', { text: 'Authenticator' }), h('span', { class: 'sub', text: setup ? 'Set a password' : 'Locked' })),
    form, err,
    h('div', { class: 'hint', text: setup
      ? 'Your 2FA codes are encrypted with this password. There is no way to recover it, so keep it somewhere safe.'
      : 'Locks again after 5 minutes without use, and when the computer locks or sleeps.' }));
}
let authAddOpen = false;
function addTotpForm() {
  const input = h('input', { placeholder: 'otpauth:// link or setup key' });
  const name = h('input', { placeholder: 'Name (e.g. GitHub)' });
  const err = h('div', { class: 'err' });
  const done = () => {
    authAddOpen = false;
    renderPop();
  };
  const add = () => call('totpAdd', input.value, name.value.trim()).then(done).catch((e) => {
    err.textContent = errText(e);
  });
  const box = h('details', { open: authAddOpen }, h('summary', { class: 'sub', style: { cursor: 'pointer' }, text: 'Add an account' }),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' } }, input, name,
      h('div', { style: { display: 'flex', gap: '8px' } },
        h('button', { class: 'btn primary', text: 'Add', onclick: add }),
        h('button', { class: 'btn', text: 'Scan QR on this page', onclick: () => call('totpScan').then((id) => {
          if (id) done();
          else err.textContent = 'No authenticator QR code found on this page.';
        }).catch((e) => {
          err.textContent = errText(e);
        }) })), err));
  box.addEventListener('toggle', () => {
    authAddOpen = box.open;
    if (box.open) setTimeout(() => input.focus(), 0);
  });
  return box;
}

// ---- KeePass
let kpQuery = '';
let kpToast = '';
async function popKeePass() {
  const v = await call('vault');
  const root = h('div', { style: { width: '340px' } });
  root.append(h('h3', {}, h('span', { text: 'KeePass' }), h('span', { class: 'sub', text: v.locked ? 'Database locked' : `Open · ${v.file}` })));
  if (v.locked) {
    const pw = h('input', { type: 'password', placeholder: 'Master password', autofocus: true });
    const err = h('div', { class: 'err' });
    const form = h('form', { style: { display: 'flex', gap: '8px' } }, pw, h('button', { class: 'btn primary', style: { height: '34px' }, text: 'Unlock' }));
    form.onsubmit = (e) => {
      e.preventDefault();
      err.textContent = 'Unlocking…';
      call('vaultUnlock', pw.value).then(() => {
        kpToast = '';
        renderPop();
      }).catch((ex) => {
        err.textContent = ex.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        pw.select();
      });
    };
    root.append(
      h('div', { class: 'row' }, h('span', { class: 'mono sub', text: v.path ? v.path.replace(/^.*[\\/](Home|Documents)[\\/]/, '~/$1/') : 'No database chosen' }),
        h('span', { class: 'chip', text: v.path ? 'Change' : 'Choose…', onclick: () => call('vaultChoose').then(renderPop) })),
      v.path ? form : null, err,
      h('div', { class: 'hint', text: 'Opens your KeePass2 / KeePassXC .kdbx file directly. The database and master password never leave this computer, and it locks itself after 15 minutes.' }));
    return root;
  }
  const search = h('input', { placeholder: 'Search entries', value: kpQuery, autofocus: true });
  const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  const label = h('div', { class: 'label' });
  const draw = async () => {
    const r = await call('vaultSearch', kpQuery);
    label.textContent = r.label;
    list.replaceChildren(...r.items.slice(0, 6).map((e) => h('div', { class: 'entry' },
      h('div', { class: 'letter', text: (e.title[0] || '?').toUpperCase() }),
      h('div', { class: 'grow' }, h('span', { style: { fontWeight: 500 }, text: e.title }), h('span', { class: 'sub', text: e.user })),
      h('span', { class: 'chip lit', text: 'Fill', onclick: () => call('vaultFill', e.id).catch((ex) => {
        kpToast = ex.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        renderPop();
      }) }),
      h('span', { class: 'chip', text: 'Copy', onclick: () => call('vaultCopy', e.id, 'password').then(() => {
        kpToast = `Password for ${e.title} copied. It clears in 30 s.`;
        toast.textContent = kpToast;
      }) }))));
    if (!r.items.length) list.append(h('div', { class: 'empty', text: 'No entries.' }));
  };
  search.addEventListener('input', () => {
    kpQuery = search.value;
    draw();
  });
  const gen = h('span', { class: 'mono', text: '••••••••' });
  const toast = h('div', { class: 'hint', text: kpToast });
  root.append(search, label, list,
    h('div', { class: 'row', style: { fontSize: '12px', paddingTop: '4px' } },
      h('span', { title: 'Generate a strong password and copy it', onclick: () => call('generate').then((p) => {
        gen.textContent = p;
        toast.textContent = 'New password copied. It clears in 30 s.';
      }) }, 'Generate: ', gen),
      h('span', { class: 'muted', text: 'Lock', onclick: () => call('vaultLock').then(() => {
        kpToast = 'Locked.';
        renderPop();
      }) })),
    toast);
  await draw();
  return root;
}

// ---- quick notes
let notesTimer = null;
async function popNotes() {
  const info = await call('notes');
  const ta = h('textarea', { placeholder: 'Write something…', autofocus: true });
  ta.value = info.text;
  const count = h('span');
  const upd = (saved) => {
    count.textContent = `${ta.value.length} characters · ${saved ? 'saved' : 'saving…'}`;
  };
  upd(true);
  ta.addEventListener('input', () => {
    upd(false);
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => call('notesSave', ta.value).then(() => upd(true)), 500);
  });
  return h('div', { style: { width: '320px' } },
    h('h3', {}, h('span', { text: 'Quick notes' }), h('span', { class: 'mono sub', text: info.label })), ta,
    h('div', { class: 'row', style: { fontSize: '11px', color: 'var(--muted)', cursor: 'default' } }, count,
      h('span', { class: 'chip', text: 'Clip page link', onclick: async () => {
        const line = await call('clip');
        if (!line) return;
        ta.value += (ta.value && !ta.value.endsWith('\n') ? '\n' : '') + line;
        ta.dispatchEvent(new Event('input'));
      } })));
}

// ---- downloads
async function popDownloads() {
  const list = await call('downloads');
  return h('div', { style: { width: '340px' } },
    h('h3', {}, h('span', { text: 'Downloads' }), h('span', { class: 'sub', style: { cursor: 'pointer' }, text: 'Clear',
                                                              onclick: () => call('dlClear').then(renderPop) })),
    ...list.map((d) => {
      const pct = d.total ? Math.min(100, (d.received / d.total) * 100) : d.state === 'completed' ? 100 : 0;
      const info = d.state === 'progressing' ? `${Math.round(pct)}% · ${fmtBytes(d.received)}${d.total ? ` of ${fmtBytes(d.total)}` : ''}`
        : d.state === 'completed' ? fmtBytes(d.total || d.received) : d.state;
      return h('div', { class: `card${d.state === 'completed' ? ' click' : ''}`, onclick: d.state === 'completed' ? () => call('dl', d.id, 'open') : null },
        h('div', { class: 'row', style: { cursor: 'inherit' } }, h('span', { style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: d.name }),
          h('span', { class: 'mono sub', text: info })),
        h('div', { class: 'bar' }, h('div', { class: d.state === 'completed' ? 'done' : '', style: { width: `${pct}%` } })),
        h('div', { style: { display: 'flex', gap: '6px' } },
          d.state === 'completed' ? h('span', { class: 'chip', text: 'Show in folder', onclick: (e) => { e.stopPropagation(); call('dl', d.id, 'show'); } }) : null,
          d.state === 'progressing' ? h('span', { class: 'chip', text: 'Pause', onclick: (e) => { e.stopPropagation(); call('dl', d.id, 'pause'); } }) : null,
          d.state === 'paused' ? h('span', { class: 'chip', text: 'Resume', onclick: (e) => { e.stopPropagation(); call('dl', d.id, 'resume'); } }) : null,
          ['progressing', 'paused'].includes(d.state) ? h('span', { class: 'chip', text: 'Cancel', onclick: (e) => { e.stopPropagation(); call('dl', d.id, 'cancel'); } }) : null));
    }),
    h('div', { class: 'hint', text: list.length ? `Saving to ${list[0].dir}` : 'No downloads yet.' }));
}

// ---- media
const MEDIA_D = { prev: 'M4 3h2v10H4zM13 3v10L7 8z', play: 'M4 2.5v11L13 8z', pause: 'M4 3h3v10H4zM9 3h3v10H9z', next: 'M10 3h2v10h-2zM3 3v10l6-5z' };
async function popMedia() {
  const list = await call('media');
  const root = h('div', { style: { width: '300px' } }, h('h3', { text: 'Now playing' }));
  if (!list.length) {
    root.append(h('div', { class: 'empty', text: 'Nothing is playing.' }));
    return root;
  }
  for (const m of list.slice(0, 3)) {
    root.append(
      h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', cursor: 'pointer' }, onclick: () => call('mediaControl', m.id, 'focus') },
        h('div', { class: 'art' }),
        h('div', { class: 'grow' }, h('span', { style: { fontWeight: 500 }, text: m.title }), h('span', { class: 'sub', text: m.host }))),
      h('div', { style: { display: 'flex', justifyContent: 'center', gap: '12px' } },
        h('button', { class: 'round', title: 'Previous', onclick: () => call('mediaControl', m.id, 'prev') }, svg(MEDIA_D.prev, true)),
        h('button', { class: 'round', title: m.playing ? 'Pause' : 'Play', onclick: () => call('mediaControl', m.id, 'toggle').then(() => setTimeout(renderPop, 300)) },
          svg(m.playing ? MEDIA_D.pause : MEDIA_D.play, true)),
        h('button', { class: 'round', title: 'Next', onclick: () => call('mediaControl', m.id, 'next') }, svg(MEDIA_D.next, true))));
  }
  return root;
}

// ---- address suggestions
function popSuggest() {
  const icon = { bookmark: '★', history: '↺', search: '⌕' };
  return h('div', { class: 'suggest', role: 'listbox' },
    ...sugg.map((s, i) => h('div', { class: `s${i === suggSel ? ' sel' : ''}`, role: 'option',
                                       onmousedown: (e) => {
                                         e.preventDefault();
                                         addrDirty = false;
                                         closePop();
                                         call('navigate', s.url);
                                       } },
      h('span', { class: 'k', text: icon[s.kind] || '•' }), h('span', { class: 't', text: s.title }),
      s.kind === 'search' ? null : h('span', { class: 'u', text: s.url.replace(/^https?:\/\/(www\.)?/, '') }))));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && popName && popName !== 'suggest') closePop();
});
