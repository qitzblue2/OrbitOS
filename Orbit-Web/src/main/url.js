'use strict';
// Turning what someone typed in the address bar into a URL.
const { ENGINES } = require('./schema');

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i;
const HOSTLIKE = /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i;

function toUrl(input, engine = 'duckduckgo') {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^aphelion:\/\//i.test(s)) return s;
  if (/^(https?|file|ftp|data|view-source):/i.test(s)) {
    try {
      return new URL(s).href;
    } catch {
      /* fall through to search */
    }
  }
  if (/^about:/i.test(s)) return s;
  if (!/\s/.test(s) && (LOCAL.test(s) || HOSTLIKE.test(s)) && !SCHEME.test(s.replace(/^[^:]+:\d+/, ''))) {
    try {
      return new URL(`${LOCAL.test(s) ? 'http' : 'https'}://${s}`).href;
    } catch {
      /* search */
    }
  }
  const e = ENGINES[engine] || ENGINES.duckduckgo;
  return e.search.replace('%s', encodeURIComponent(s));
}

function displayUrl(url) {
  if (!url || url.startsWith('aphelion://newtab')) return '';
  return url;
}

function isSecure(url) {
  return /^(https:|aphelion:|file:)/.test(url || '');
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

module.exports = { toUrl, displayUrl, isSecure, hostOf };
