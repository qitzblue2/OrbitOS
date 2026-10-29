import { boot, call } from './shared/page.js';

await boot();
const a = await call('reader');
const body = document.getElementById('body');
if (!a) {
  body.textContent = 'Nothing to show. Open reader view from an article page.';
} else {
  document.title = a.title;
  document.getElementById('title').textContent = a.title;
  document.getElementById('by').textContent = a.byline || '';
  document.getElementById('site').textContent = a.site || '';
  if (a.lang) document.documentElement.lang = a.lang;
  // Readability already removed scripts; clean again anyway, and the page CSP blocks inline code.
  const doc = new DOMParser().parseFromString(a.content, 'text/html');
  for (const el of doc.querySelectorAll('script,style,iframe,object,embed,form,input,button,link,meta,base')) el.remove();
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || (/^(href|src|srcset|action|formaction|xlink:href)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === 'A') el.setAttribute('rel', 'noopener noreferrer');
  }
  body.replaceChildren(...doc.body.childNodes);
  document.getElementById('back').onclick = () => call('open', a.url);
}
const art = document.getElementById('art');
let size = 18;
document.getElementById('smaller').onclick = () => art.style.setProperty('--size', `${(size = Math.max(14, size - 1))}px`);
document.getElementById('bigger').onclick = () => art.style.setProperty('--size', `${(size = Math.min(26, size + 1))}px`);
document.getElementById('serif').onclick = () => art.classList.toggle('serif');
if (!a) document.getElementById('back').hidden = true;
