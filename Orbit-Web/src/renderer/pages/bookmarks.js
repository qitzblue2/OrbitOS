import { boot, call, h, ago, api } from './shared/page.js';

await boot();
const q = document.getElementById('q');
const list = document.getElementById('list');
api.on('bookmarks', draw);

async function draw() {
  const s = q.value.toLowerCase().trim();
  const items = (await call('bookmarks')).filter((b) => !s || b.title.toLowerCase().includes(s) || b.url.toLowerCase().includes(s));
  if (!items.length) {
    return list.replaceChildren(h('div', { class: 'empty', text: s ? 'No matches.' : 'Press ☆ in the address bar (or Ctrl+D) to bookmark a page.' }));
  }
  list.replaceChildren(h('div', { class: 'card' }, ...items.map((b) => {
    let host = '';
    try {
      host = new URL(b.url).hostname.replace(/^www\./, '');
    } catch { /* keep empty */ }
    return h('div', { class: 'entry', tabindex: '0', onclick: () => call('open', b.url), onkeydown: (e) => e.key === 'Enter' && call('open', b.url) },
      h('div', { class: 'ic', text: (host[0] || '★').toUpperCase() }),
      h('div', { class: 't' }, h('b', { text: b.title }), h('span', { text: b.url })),
      h('span', { class: 'when', text: ago(b.time) }),
      h('button', { class: 'rm', title: 'Remove bookmark', 'aria-label': 'Remove', text: '×', onclick: async (e) => {
        e.stopPropagation();
        await call('bookmarkRemove', b.url);
        draw();
      } }));
  })));
}
q.addEventListener('input', draw);
draw();
