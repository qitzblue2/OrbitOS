import { boot, call, h, sw, toast, api } from './shared/page.js';
import { BGS, bgValue } from './shared/backgrounds.js';

let S = await boot();
let N = await call('newtab');
const $ = (sel) => document.querySelector(sel);
const q = $('#q');

$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  if (q.value.trim()) call('open', q.value.trim());
});

// ---------------------------------------------------------------- icons
const ICON = {
  star: 'M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6z',
  gear: 'M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  plus: 'M8 3v10M3 8h10',
  clock: 'M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2zM8 4.8V8l2.2 1.4',
};
const svg = (d) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  s.append(p);
  return s;
};
// a letter tile gets a stable colour from its host, so each site keeps "its" colour
const tint = (host) => {
  let n = 0;
  for (const c of host) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${n % 360} 55% 42%)`;
};

// ---------------------------------------------------------------- page
function applyLayout() {
  $('#brand').hidden = !N.showBrand;
  $('#search').hidden = !N.showSearch;
  $('#tiles').hidden = !N.showTiles;
  $('#clock').hidden = !N.showClock;
  const tiles = $('#tiles');
  tiles.className = [N.size, N.shape, N.labels ? '' : 'nolabels'].join(' ');
  tiles.style.setProperty('--cols', N.columns);
  const pic = $('#picture');
  pic.classList.toggle('on', N.image);
  pic.style.backgroundImage = N.image ? `url("background?v=${N.imageVersion}")` : '';
  pic.style.setProperty('--dim', N.dim / 100);
  pic.style.filter = N.blur ? `blur(${N.blur}px)` : '';
  pic.style.inset = N.blur ? `-${N.blur * 2}px` : '0';
  q.placeholder = `Search with ${S.engines[S.engine]} or type an address`;
  tickClock();
}

function tickClock() {
  if (!N.showClock) return;
  const now = new Date();
  $('#clock .time').textContent = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const hr = now.getHours();
  const part = hr < 6 ? 'Good night' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  $('#clock .greet').textContent = N.greeting ? N.greeting : `${part} · ${now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}`;
}
setInterval(tickClock, 15000);

async function renderTiles() {
  const sites = await call('topSites');
  const tiles = $('#tiles');
  const max = N.columns * N.rows;
  const tile = ({ name, icon, color, onClick, title, removable, ctx, cls = '' }) => {
    const ic = h('div', { class: 'ic', style: color ? { background: color, borderColor: 'transparent' } : {} });
    if (typeof icon === 'string' && icon.startsWith('data:')) {
      const img = h('img', { alt: '', src: icon });
      img.onerror = () => img.replaceWith(name[0].toUpperCase());
      ic.append(img);
    } else if (icon instanceof Element) {
      ic.append(icon);
    } else {
      ic.textContent = icon;
    }
    const el = h('div', { class: `tile ${cls}`, tabindex: '0', role: 'link', title, onclick: onClick,
                          onkeydown: (e) => e.key === 'Enter' && onClick(),
                          oncontextmenu: ctx ? (e) => { e.preventDefault(); ctx(e); } : null },
      ic, h('span', { class: 'nm', text: name }),
      removable ? h('button', { class: 'x', type: 'button', title: 'Remove', 'aria-label': `Remove ${name}`,
                                onclick: (e) => { e.stopPropagation(); removable(); } }, '✕') : null);
    return el;
  };
  const list = sites.map((site) => {
    const name = site.title && site.title.length < 22 ? site.title : site.host.replace(/^www\./, '').split('.')[0];
    return tile({
      name: name || site.host, title: site.url,
      icon: site.icon || (name || site.host)[0].toUpperCase(), color: site.icon ? '' : tint(site.host),
      onClick: () => call('open', site.url),
      removable: () => call('newtabShortcut', 'remove', site.host),
      ctx: (e) => menu(e, [
        ['Open in new tab', () => call('open', site.url, 'tab')],
        ['Rename…', () => editShortcut({ title: name, url: site.url, host: site.host, rename: true })],
        ['Remove', () => call('newtabShortcut', 'remove', site.host)],
      ]),
    });
  });
  // "Add shortcut" (and Bookmarks in automatic mode) fill free places; sites keep priority
  const extras = [tile({ name: 'Add shortcut', icon: svg(ICON.plus), onClick: () => editShortcut(), title: 'Add a shortcut', cls: 'add' })];
  if (N.source === 'auto') {
    extras.push(tile({ name: 'Bookmarks', icon: svg(ICON.star), color: 'hsl(42 80% 45%)', onClick: () => call('open', 'aphelion://bookmarks/'), title: 'Your bookmarks' }));
  }
  const shown = list.slice(0, Math.max(0, max - 1));   // always leave room for "Add shortcut"
  tiles.replaceChildren(...shown, ...extras.slice(0, max - shown.length));
  $('#note').textContent = sites.length ? '' : 'Sites you visit often and your own shortcuts appear here. Nothing on this page comes from the internet.';
}

// ---------------------------------------------------------------- context menu + dialog
function menu(e, items) {
  const m = $('#menu');
  m.replaceChildren(...items.map(([label, fn]) => h('button', { type: 'button', role: 'menuitem', text: label, onclick: () => { m.hidden = true; fn(); } })));
  m.hidden = false;
  m.style.left = `${Math.min(e.clientX, innerWidth - 190)}px`;
  m.style.top = `${Math.min(e.clientY, innerHeight - 140)}px`;
}
addEventListener('click', (e) => { if (!e.target.closest('#menu')) $('#menu').hidden = true; });
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  $('#menu').hidden = true;
  document.querySelector('.dialog')?.remove();
});

function editShortcut(cur = null) {
  const title = h('input', { class: 'field', placeholder: 'Name', value: cur?.title || '' });
  const url = h('input', { class: 'field', placeholder: 'Address, e.g. youtube.com', value: cur?.url || '', disabled: cur?.rename || null });
  const err = h('div', { class: 'err' });
  const form = h('form', {}, h('h3', { text: cur?.rename ? 'Rename shortcut' : 'Add shortcut' }), title, url, err,
    h('div', { class: 'btns' },
      h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => box.remove() }),
      h('button', { class: 'btn primary', type: 'submit', text: cur?.rename ? 'Save' : 'Add' })));
  const box = h('div', { class: 'dialog', onclick: (e) => e.target === box && box.remove() }, form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      if (cur?.rename) {
        // renaming an automatic tile turns it into one of your own shortcuts
        await api.call('newtabShortcut', 'add', { title: title.value, url: cur.url });
        await api.call('newtabShortcut', 'rename', { host: cur.host, title: title.value });
      } else {
        await api.call('newtabShortcut', 'add', { title: title.value, url: url.value });
      }
      box.remove();
    } catch (x) {
      err.textContent = String(x.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  };
  document.body.append(box);
  (cur?.rename ? title : url).focus();
}

// ---------------------------------------------------------------- customize panel
const set = (patch) => call('newtabSet', patch);
const seg = (value, options, onPick) => h('div', { class: 'seg', role: 'group' },
  ...options.map(([v, label]) => h('button', { type: 'button', 'aria-pressed': String(v === value), text: label, onclick: () => onPick(v) })));
const slider = (value, min, max, onInput, label) => h('input', { type: 'range', min, max, value, 'aria-label': label,
                                                              oninput: (e) => onInput(Number(e.target.value)) });

function renderPanel() {
  const p = $('#panel');
  if (p.hidden) return;
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
  file.onchange = () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 15 * 1024 * 1024) return toast('That picture is larger than 15 MB');
    const r = new FileReader();
    r.onload = () => call('newtabImage', r.result).then(() => toast('Background picture set'));
    r.readAsDataURL(f);
  };
  const themes = Object.keys(BGS);
  let dimTimer = null;
  const later = (patch) => {
    clearTimeout(dimTimer);
    dimTimer = setTimeout(() => set(patch), 150);
  };
  p.replaceChildren(
    h('h2', {}, 'Customize', h('button', { class: 'close', type: 'button', 'aria-label': 'Close', text: '✕', onclick: togglePanel })),
    h('section', {}, h('h3', { text: 'Show' }),
      ...[['showClock', 'Clock and greeting'], ['showBrand', 'Aphelion logo'], ['showSearch', 'Search box'], ['showTiles', 'Shortcuts'], ['labels', 'Shortcut names']]
        .map(([k, label]) => h('div', { class: 'row' }, h('span', { text: label }), sw(N[k], () => set({ [k]: !N[k] }), label))),
      h('div', { class: 'row' }, h('input', { type: 'text', class: 'field', placeholder: 'Your own greeting (optional)', value: N.greeting,
                                              oninput: (e) => later({ greeting: e.target.value }) }))),
    h('section', {}, h('h3', { text: 'Shortcuts' }),
      seg(N.source, [['auto', 'Most visited'], ['mine', 'Only mine']], (v) => set({ source: v })),
      h('div', { class: 'row' }, h('span', { text: 'Shape' }), seg(N.shape, [['rounded', 'Rounded'], ['circle', 'Circle'], ['square', 'Square']], (v) => set({ shape: v }))),
      h('div', { class: 'row' }, h('span', { text: 'Size' }), seg(N.size, [['s', 'S'], ['m', 'M'], ['l', 'L']], (v) => set({ size: v }))),
      h('div', { class: 'row' }, h('span', { text: `Columns · ${N.columns}` }), slider(N.columns, 3, 8, (v) => set({ columns: v }), 'Columns')),
      h('div', { class: 'row' }, h('span', { text: `Rows · ${N.rows}` }), slider(N.rows, 1, 4, (v) => set({ rows: v }), 'Rows')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', text: 'Add shortcut', onclick: () => editShortcut() }),
        N.hidden.length ? h('button', { class: 'btn', type: 'button', text: `Bring back ${N.hidden.length} removed`,
                                       onclick: () => call('newtabShortcut', 'restore') }) : null)),
    h('section', {}, h('h3', { text: 'Background' }),
      h('div', { class: 'bgs' }, ...themes.map((t) => h('button', { type: 'button', title: t, 'aria-label': t,
                                                                     'aria-pressed': String(!N.image && S.bg === t),
                                                                     style: { background: bgValue(t) },
                                                                     onclick: async () => {
                                                                       if (N.image) await set({ image: false });
                                                                       await call('setSetting', 'bg', t);
                                                                     } }))),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', text: N.image ? 'Change picture…' : 'Use my own picture…', onclick: () => file.click() }),
        N.image ? h('button', { class: 'btn', type: 'button', text: 'Remove', onclick: () => call('newtabImage', null) }) : null, file),
      N.image ? h('div', { class: 'row' }, h('span', { text: `Darken · ${N.dim}%` }), slider(N.dim, 0, 70, (v) => {
        $('#picture').style.setProperty('--dim', v / 100);
        later({ dim: v });
      }, 'Darken')) : null,
      N.image ? h('div', { class: 'row' }, h('span', { text: `Blur · ${N.blur}px` }), slider(N.blur, 0, 20, (v) => later({ blur: v }), 'Blur')) : null,
      h('div', { class: 'faint', style: { fontSize: '12px' }, text: 'More looks (Glass, Graphite, Light, Lagoon) and colours are in Settings → Appearance.' })));
}

function togglePanel() {
  const p = $('#panel');
  p.hidden = !p.hidden;
  $('#customize').setAttribute('aria-expanded', String(!p.hidden));
  $('#customize').hidden = !p.hidden;
  renderPanel();
}
$('#customize').addEventListener('click', togglePanel);

// ---------------------------------------------------------------- live updates
api.on('newtab', async () => {
  N = await call('newtab');
  applyLayout();
  renderTiles();
  renderPanel();
});
api.on('settings', (s) => {
  S = { ...S, ...s };
  applyLayout();
  renderPanel();
});

applyLayout();
renderTiles();
