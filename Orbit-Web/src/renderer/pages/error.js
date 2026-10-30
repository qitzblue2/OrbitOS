import { boot, call, h } from './shared/page.js';

const s = await boot();
const p = new URLSearchParams(location.search);
const code = p.get('code');
const url = p.get('url') || '';
const desc = p.get('desc') || '';
let host = url;
try {
  host = new URL(url).hostname;
} catch { /* keep raw */ }

const MSG = {
  '-105': ['Can’t find this site', `${host} could not be found. Check the address, or your internet connection.`],
  '-106': ['You’re offline', 'Check your Wi-Fi or network cable, then try again.'],
  '-102': ['The site refused to connect', `${host} isn’t accepting connections right now.`],
  '-118': ['The site took too long', `${host} didn’t answer in time.`],
  '-21': ['Your network changed', 'The connection changed while loading. Try again.'],
  '-20': ['Blocked', 'This request was blocked.'],
  '-300': ['That address isn’t valid', 'Check what you typed.'],
  focus: ['Focus time', `${host} stays closed until your focus session ends. You’ve got this.`],
  crashed: ['This tab crashed', 'Something in the page made it stop. Reloading usually fixes it.'],
  cert: ['This connection isn’t private', `The security certificate for ${host} is not valid, so Aphelion stopped before anything was sent. ` +
         'Someone could be trying to read your data, or the site is misconfigured.'],
};
const [title, text] = MSG[code] || ['This page didn’t load', `${host} couldn’t be loaded.`];
document.getElementById('title').textContent = title;
document.getElementById('desc').textContent = text;
document.getElementById('url').textContent = url;
document.getElementById('tech').textContent = `${code} ${desc}`;
document.title = title;
const actions = document.getElementById('actions');
if (code !== 'cert' && code !== 'focus') actions.append(h('button', { class: 'btn primary', text: 'Try again', onclick: () => call('retry', url) }));
// HTTPS-only upgraded this address and the secure version failed: offer the plain one, clearly labelled
if (s.https && url.startsWith('https:') && code !== 'cert' && ['-102', '-105', '-118', '-107', '-200', '-201', '-202', '-100', '-101'].includes(code)) {
  actions.append(h('button', { class: 'btn', text: `Continue to http://${host} (not secure)`, onclick: () => call('httpContinue', url) }));
}
actions.append(h('button', { class: 'btn', text: 'New tab', onclick: () => call('open', 'aphelion://newtab/') }));
