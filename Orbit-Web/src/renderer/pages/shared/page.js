// Helpers shared by aphelion:// pages. `window.aphelion` comes from the tab preload and
// only exists on aphelion:// pages.
import { bgValue } from './backgrounds.js';

export const api = window.aphelion;
export const call = (name, ...a) => api.call(name, ...a).catch((e) => {
  toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  throw e;
});

export function h(tag, attrs = {}, ...kids) {
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

export function sw(on, onClick, label) {
  return h('button', { class: 'switch', role: 'switch', 'aria-checked': String(Boolean(on)), 'aria-label': label,
                       onclick: (e) => { e.stopPropagation(); onClick(); } });
}

export function toast(text) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status', text });
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

export function applyTheme(s) {
  const style = s.effectiveStyle || (s.style === 'auto' ? 'Glass' : s.style);
  const cls = [`style-${style.toLowerCase()}`, s.reduce && 'reduce', s.contrast && 'contrast', s.motion && 'motion', s.bigtext && 'bigtext'];
  document.documentElement.className = cls.filter(Boolean).join(' ');
  document.documentElement.style.setProperty('--wall', bgValue(s.bg));
  document.documentElement.style.setProperty('--chrome', s.compact ? '88px' : '94px');
}

export async function boot() {
  const s = await api.call('settings');
  applyTheme(s);
  api.on('settings', applyTheme);
  return s;
}

export function ago(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
