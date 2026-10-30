import { boot, call, h, sw, toast, api } from './shared/page.js';
import { BGS, SOLIDS, PHOTOS, bgValue } from './shared/backgrounds.js';

let S = await boot();
api.on('settings', (s) => {
  S = s;
  draw();
});
let onUpdateProgress = null;   // set by the About section while it is shown
api.on('update-progress', (f) => onUpdateProgress?.(f));

// type: t = toggle, v = value (select), a = action button, x = custom block
const SECTIONS = {
  general: ['General', 'Startup, tabs and downloads.', () => [
    ['t', 'restore', 'Restore tabs on launch', 'Reopen what you had open last time'],
    ['v', 'startup', 'On new tab', { start: 'Aphelion start page', blank: 'Blank page' }],
    ['a', 'Download location', S.downloadDirEffective, 'Change…', () => call('chooseFolder', 'downloadDir').then(set)],
    ['t', 'askdl', 'Ask where to save files', 'Prompt before each download'],
    ['a', 'Default browser', 'Open links from other apps in Aphelion', 'Make default', async () => {
      toast((await call('makeDefault')) ? 'Aphelion is now your default browser' : 'Your system asked to confirm this in its own settings');
    }],
  ]],
  appearance: ['Appearance', S.orbit ? 'Matches the Orbit desktop style.' : 'Glass, Graphite or Light.', () => [
    ['x', appearanceBlock],
    ['t', 'reduce', 'Reduce transparency', 'Solid colors instead of frosted glass'],
    ['t', 'compact', 'Compact tabs', 'Shorter tab strip'],
    ['v', 'zoom', 'Default zoom', Object.fromEntries([67, 75, 80, 90, 100, 110, 125, 150, 175, 200].map((z) => [z, `${z}%`]))],
  ]],
  privacy: ['Privacy & security', 'Protection on by default.', () => [
    ['t', 'shield', 'Tracker shield', 'Block known trackers and fingerprinting'],
    ['t', 'https', 'HTTPS-only mode', 'Upgrade every connection'],
    ['t', 'cookies', 'Block third-party cookies', 'Sites you visit can’t be followed by other sites'],
    ['t', 'dnt', 'Send Do Not Track', 'Also sends Global Privacy Control (Sec-GPC)'],
    ['t', 'webrtc', 'Protect IP in WebRTC', 'Hide your local address from sites'],
    ['v', 'clear', 'Clear data on exit', { off: 'Keep everything', history: 'History', cookies: 'Cookies & site data', all: 'History & cookies' }],
    ['x', listsBlock], ['x', clearBlock], ['x', pickedBlock], ['x', permsBlock],
  ]],
  search: ['Search', 'Address bar behavior.', () => [
    ['v', 'engine', 'Search engine', S.engines],
    ['t', 'suggest', 'Show suggestions', `Send what you type to ${S.engines[S.engine]} for suggestions`],
  ]],
  performance: ['Performance', 'Speed and battery.', () => [
    ['t', 'sleep', 'Sleeping tabs', 'Pause tabs you haven’t used in 30 minutes'],
    ['t', 'memsave', 'Memory saver', 'Pause background tabs after 10 minutes instead'],
    ['t', 'gpu', 'Hardware acceleration', 'Use the GPU when available (takes effect after a restart)'],
    ['t', 'preload', 'Preload pages', 'Connect to the top address-bar suggestion before you press Enter'],
  ]],
  accessibility: ['Accessibility', 'Reading and motion.', () => [
    ['t', 'bigtext', 'Larger text', 'Increase interface and page text size'],
    ['t', 'contrast', 'High contrast', 'Stronger borders and solid surfaces'],
    ['t', 'motion', 'Reduce motion', 'Turn off interface animations'],
    ['t', 'caret', 'Caret browsing', 'Move through pages with a text cursor (F7)'],
  ]],
  languages: ['Languages', 'Translation and spelling.', () => [
    ['v', 'lang', 'Preferred language', S.languages],
    ['t', 'translate', 'Offer to translate pages', 'Asks once per tab; pages are only sent to Google Translate after you click Translate'],
    ['t', 'spell', 'Spell check', 'Check spelling as you type'],
  ]],
  passwords: ['Passwords', 'Saved logins and autofill, kept in your KeePass database.', () => [
    ['a', 'KeePass database', S.vaultPath || 'None chosen: Passwords.kdbx in Documents is found automatically', 'Choose…',
     () => call('chooseVault').then(set)],
    ['t', 'save', 'Offer to save passwords', 'After you log in, offer to add it to KeePass (while it’s unlocked)'],
    ['t', 'autofill', 'Autofill forms', 'Fill the login when exactly one KeePass entry matches the site'],
  ]],
  extensions: ['Extensions', 'Built-in add-ons and app integrations.', () => [
    ['t', 'wNotes', 'Quick notes', `Jot notes into ${S.orbit ? '~/Home/Notes' : 'Documents/Aphelion'}`],
    ['t', 'wDl', 'Downloads widget', 'Live progress in the address bar'],
    ['t', 'wMedia', 'Media controls', 'Play and pause audio in any tab'],
    ['t', 'wAds', 'Ad blocker', 'Blocks ads and pop-ups with filter lists'],
    ['t', 'wAuth', 'Authenticator', 'Two-factor codes, stored encrypted on this device'],
    ['t', 'wKp', 'KeePass integration', 'Fill logins from your KeePass database'],
    ['t', 'ext1', 'Reader view', 'Distraction-free articles'],
    ['t', 'ext2', 'Dark pages', 'Force dark colors on bright sites'],
    ['x', totpBlock],
  ]],
  about: ['About Aphelion', `Version ${S.version} · ${S.orbit ? 'for Orbit OS' : 'from Orbit OS'}`, () => [['x', aboutBlock]]],
};

let current = location.hash.slice(1) in SECTIONS ? location.hash.slice(1) : 'general';
const side = document.getElementById('side');
for (const [key, [label]] of Object.entries(SECTIONS)) {
  side.append(h('button', { 'data-sec': key, text: label, onclick: () => {
    current = key;
    history.replaceState(null, '', `#${key}`);
    draw();
  } }));
}

function set(s) {
  if (s) S = s;
  draw();
}

async function setting(key, value) {
  await call('setSetting', key, value);
  S = await call('settings');
  draw();
}

function draw() {
  for (const b of side.querySelectorAll('button')) b.setAttribute('aria-current', b.dataset.sec === current ? 'page' : 'false');
  const [title, desc, rows] = SECTIONS[current];
  const main = document.getElementById('main');
  const out = [h('div', { class: 'sec-head' }, h('h1', { text: title }), h('p', { text: desc }))];
  let card = null;
  for (const r of rows()) {
    if (r[0] === 'x') {
      card = null;
      out.push(r[1]());
      continue;
    }
    if (!card) {
      card = h('div', { class: 'card' });
      out.push(card);
    }
    card.append(row(r));
  }
  main.replaceChildren(...out);
}

function row([type, ...a]) {
  if (type === 't') {
    const [key, label, hint] = a;
    return h('div', { class: 'row click', onclick: () => setting(key, !S[key]) },
      h('div', { class: 'lbl' }, h('b', { text: label }), hint ? h('span', { text: hint }) : null), sw(S[key], () => setting(key, !S[key]), label));
  }
  if (type === 'v') {
    const [key, label, options] = a;
    const sel = h('select', { class: 'value', 'aria-label': label });
    for (const [v, name] of Object.entries(options)) sel.append(h('option', { value: v, text: `${name} ▾`, selected: String(S[key]) === String(v) }));
    sel.onchange = () => setting(key, typeof S[key] === 'number' ? Number(sel.value) : sel.value);
    return h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('b', { text: label })), sel);
  }
  const [label, hint, btn, fn] = a;
  return h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('b', { text: label }), h('span', { class: 'mono', text: hint })),
           h('button', { class: 'btn', text: btn, onclick: fn }));
}

// ---------- custom blocks ----------
function appearanceBlock() {
  const styles = [['auto', S.orbit ? 'Match Orbit OS' : 'Match system', 'linear-gradient(135deg,#f28dc4,#3a3a40 50%,#f1f1f3)'],
                  ['Glass', 'Glass', 'linear-gradient(135deg,#f28dc4,#9b6cf0,#5aa6ff)'],
                  ['Graphite', 'Graphite', 'linear-gradient(135deg,#3a3a40,#161618)'],
                  ['Light', 'Light', 'linear-gradient(135deg,#f7cfe6,#d9ccf7,#cfe2ff)']];
  const card = (key, name, sw_, cls) => h('button', { class: cls, 'aria-pressed': String(S.bg === key), title: name, onclick: () => setting('bg', key) },
    h('div', { class: 'sw', style: { background: sw_ } }), h('span', { text: name }));
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '20px' } },
    h('div', { class: 'group' }, h('div', { class: 'group-title', text: 'Style' }),
      h('div', { class: 'styles' }, ...styles.map(([k, n, g]) => h('button', { class: 'style-card', 'aria-pressed': String(S.style === k),
                                                                                onclick: () => setting('style', k) },
        h('div', { class: 'sw', style: { background: g } }), h('span', { text: n }))))),
    h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Browser background', h('span', { text: 'Orbit wallpapers · branding/tokens.json' })),
      h('div', { class: 'bgs' }, ...Object.keys(BGS).map((k) => card(k, k, BGS[k], 'bg-card')))),
    h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Solid colors', h('span', { text: 'Orbit scheme tokens' })),
      h('div', { class: 'bgs' }, ...SOLIDS.map(([n, c]) => card(`s:${c}`, n, c, 'bg-card')))),
    h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Photos', h('span', { text: 'loaded from picsum.photos (Unsplash) only if you pick one' })),
      h('div', { class: 'bgs' }, ...PHOTOS.map(([n, id]) => {
        const c = card(`p:${id}`, n, 'var(--fill)', 'bg-card');
        c.querySelector('.sw').dataset.photo = id;
        return c;
      }))),
    h('div', { class: 'actions' }, h('button', { class: 'btn', text: 'Show photo previews', onclick: (e) => {
      for (const el of document.querySelectorAll('[data-photo]')) el.style.background = `url(https://picsum.photos/id/${el.dataset.photo}/300/200) center / cover`;
      e.target.remove();
    } })));
}

function listsBlock() {
  const m = S.lists || {};
  const btn = h('button', { class: 'btn', text: 'Update now', onclick: async () => {
    btn.disabled = true;
    btn.textContent = 'Updating…';
    try {
      S = await call('updateLists');
      toast('Filter lists updated');
    } finally {
      draw();
    }
  } });
  return h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Filter lists', h('span', { text: 'checked only when you press Update' })),
    h('div', { class: 'card' }, ...Object.values(m).map((l) => h('div', { class: 'list-item' }, h('span', { class: 'grow', text: l.name }),
      h('span', { class: 'mono faint', text: `${(l.rules || 0).toLocaleString()} rules · ${l.fetched ? new Date(l.fetched).toLocaleDateString() : '—'}` }))),
      h('div', { class: 'list-item' }, h('span', { class: 'grow muted', text: 'Blocking works offline with the lists shipped with Aphelion.' }), btn)));
}

function clearBlock() {
  const c = (what, label) => h('button', { class: 'btn', text: label, onclick: async () => {
    await call('clearData', what);
    toast('Cleared');
  } });
  return h('div', { class: 'group' }, h('div', { class: 'group-title', text: 'Clear browsing data now' }),
    h('div', { class: 'actions' }, c('history', 'History'), c('cookies', 'Cookies & site data'), c('all', 'Everything')));
}

function pickedBlock() {
  const box = h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Hidden elements', h('span', { text: 'from “Pick element to hide”' })));
  call('picked').then((p) => {
    const items = Object.entries(p).flatMap(([host, sels]) => sels.map((sel) => [host, sel]));
    box.append(items.length ? h('div', { class: 'card' }, ...items.map(([host, sel]) => h('div', { class: 'list-item' },
      h('span', { text: host }), h('span', { class: 'grow mono faint', text: sel }),
      h('button', { class: 'btn', text: 'Remove', onclick: () => call('pickedRemove', host, sel).then(draw) }))))
      : h('div', { class: 'faint', text: 'Nothing hidden yet.' }));
  });
  return box;
}

function permsBlock() {
  const box = h('div', { class: 'group' }, h('div', { class: 'group-title', text: 'Site permissions' }));
  const names = { media: 'camera / microphone', geolocation: 'location', notifications: 'notifications', 'clipboard-read': 'clipboard',
                  'display-capture': 'screen', openExternal: 'open apps', midi: 'MIDI', midiSysex: 'MIDI' };
  call('perms').then((p) => {
    const hosts = Object.entries(p);
    box.append(hosts.length ? h('div', { class: 'card' }, ...hosts.map(([host, perms]) => h('div', { class: 'list-item' },
      h('span', { text: host }),
      h('span', { class: 'grow faint', text: Object.entries(perms).map(([k, v]) => `${names[k] || k}: ${v ? 'allowed' : 'blocked'}`).join(' · ') }),
      h('button', { class: 'btn', text: 'Reset', onclick: () => call('permsReset', host).then(draw) }))))
      : h('div', { class: 'faint', text: 'No site has asked for anything yet. Aphelion asks every time until you tick “Remember”.' }));
  });
  return box;
}

function totpBlock() {
  const box = h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Authenticator accounts', h('span', { text: 'encrypted with your 2FA password and your system keychain' })));
  call('totpList').then((list) => {
    box.append(list.length ? h('div', { class: 'card' }, ...list.map((a) => h('div', { class: 'list-item' },
      h('span', { class: 'grow', text: a.account ? `${a.name} · ${a.account}` : a.name }),
      h('button', { class: 'btn danger', text: 'Remove', onclick: () => {
        if (confirm(`Remove ${a.name}? Make sure you can still log in another way.`)) call('totpRemove', a.id).then(draw);
      } }))))
      : h('div', { class: 'faint', text: 'Add accounts from the 2FA button in the address bar.' }));
  }).catch(() => {
    box.append(h('div', { class: 'faint', text: 'Locked. Unlock it with the 2FA button in the address bar, then reopen this page.' }));
  });
  return box;
}

function aboutBlock() {
  const upd = h('span', { class: 'mono', text: 'Not checked' });
  const bar = h('progress', { max: 1, value: 0, hidden: true, style: { width: '160px' } });
  // Windows: download, check and run the new installer; Aphelion closes and comes back updated
  const installBtn = h('button', { class: 'btn primary', text: 'Update now', hidden: true, onclick: async () => {
    installBtn.disabled = true;
    bar.hidden = false;
    upd.textContent = 'Downloading…';
    const r = await call('installUpdate');
    upd.textContent = r.text;
    if (r.status !== 'installing') {
      installBtn.disabled = false;
      bar.hidden = true;
    }
  } });
  onUpdateProgress = (f) => {
    bar.value = f;
    upd.textContent = `Downloading… ${Math.round(f * 100)} %`;
  };
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
    h('div', { class: 'about-mark' }, h('img', { src: 'shared/mark.svg', width: 48, height: 48, alt: '' }),
      h('div', {}, h('b', { text: 'Aphelion' }), h('div', { class: 'muted', text: 'The farthest point of an orbit: the calmest place to browse from.' }))),
    h('div', { class: 'card' },
      row(['a', 'Updates', S.platform === 'win32' ? 'Aphelion also checks by itself once a day.' : '', 'Check now', async () => {
        upd.textContent = 'Checking…';
        const r = await call('checkUpdates');
        upd.textContent = r.text;
        installBtn.hidden = r.status !== 'available';
      }]),
      h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('b', { text: 'Status' })),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, upd, bar, installBtn)),
      h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('b', { text: 'Engine' })), h('span', { class: 'mono', text: `Chromium ${S.chrome}` })),
      h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('b', { text: 'Runtime' })), h('span', { class: 'mono', text: `Electron ${S.electron} · ${S.platform}` }))),
    h('p', { class: 'muted', style: { lineHeight: '1.6', margin: 0 } },
      'Aphelion sends nothing about you anywhere: no telemetry, no account, no crash reports. It only goes online for the pages you open, ' +
      'search suggestions (if on), the updates and filter-list checks you start yourself, and photo backgrounds you pick.'),
    h('p', { class: 'faint', style: { margin: 0 } }, 'Free software under the GPL-3.0-or-later. Uses Chromium, Electron, Ghostery adblocker, ',
      'kdbxweb, Mozilla Readability and filter lists by EasyList and Fanboy.'));
}

draw();
