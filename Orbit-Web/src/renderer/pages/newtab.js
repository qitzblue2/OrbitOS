import { boot, call, h } from './shared/page.js';

const s = await boot();
const q = document.getElementById('q');
document.getElementById('search').addEventListener('submit', (e) => {
  e.preventDefault();
  if (q.value.trim()) call('open', q.value.trim());
});
q.placeholder = `Search with ${s.engines[s.engine]} or type an address`;

const sites = await call('topSites');
const tiles = document.getElementById('tiles');
const tile = (name, letter, onClick, title) => h('div', { class: 'tile', tabindex: '0', role: 'link', title, onclick: onClick,
                                                         onkeydown: (e) => e.key === 'Enter' && onClick() },
  h('div', { class: 'ic', text: letter }), h('span', { class: 'nm', text: name }));
for (const site of sites) {
  const name = (site.title && site.title.length < 18 ? site.title : site.host.replace(/^www\./, '').split('.')[0]) || site.host;
  tiles.append(tile(name, name[0].toUpperCase(), () => call('open', site.url), site.url));
}
tiles.append(tile('Bookmarks', '★', () => call('open', 'aphelion://bookmarks/'), 'Your bookmarks'));
if (sites.length < 7) tiles.append(tile('Settings', '⚙', () => call('open', 'aphelion://settings/'), 'Settings'));
document.getElementById('note').textContent = sites.length
  ? '' : 'Sites you visit often and your bookmarks appear here. Nothing on this page comes from the internet.';
