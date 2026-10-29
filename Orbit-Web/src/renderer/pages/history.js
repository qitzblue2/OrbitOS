import { boot, call, h, ago } from './shared/page.js';

await boot();
const q = document.getElementById('q');
const list = document.getElementById('list');
document.getElementById('tools').append(h('button', { class: 'btn danger', text: 'Clear history', onclick: async () => {
  if (confirm('Clear all browsing history?')) {
    await call('clearData', 'history');
    draw();
  }
} }));

function dayLabel(t) {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(Date.now() - 86400e3);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

async function draw() {
  const items = await call('history', q.value);
  if (!items.length) return list.replaceChildren(h('div', { class: 'empty', text: q.value ? 'No matches.' : 'Pages you visit appear here. Private windows are never recorded.' }));
  const out = [];
  let day = null;
  let card = null;
  for (const it of items) {
    const label = dayLabel(it.time);
    if (label !== day) {
      day = label;
      card = h('div', { class: 'card' });
      out.push(h('div', { class: 'day', text: label }), card);
    }
    let host = '';
    try {
      host = new URL(it.url).hostname.replace(/^www\./, '');
    } catch { /* keep empty */ }
    card.append(h('div', { class: 'entry', tabindex: '0', onclick: () => call('open', it.url), onkeydown: (e) => e.key === 'Enter' && call('open', it.url) },
      h('div', { class: 'ic', text: (host[0] || '?').toUpperCase() }),
      h('div', { class: 't' }, h('b', { text: it.title || it.url }), h('span', { text: it.url })),
      h('span', { class: 'when', text: new Date(it.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }),
      h('button', { class: 'rm', title: 'Remove from history', 'aria-label': 'Remove', text: '×', onclick: async (e) => {
        e.stopPropagation();
        await call('historyRemove', it.url);
        draw();
      } })));
  }
  list.replaceChildren(...out);
}
q.addEventListener('input', draw);
draw();
