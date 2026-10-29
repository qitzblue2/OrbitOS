'use strict';
// Every setting the Settings page can change, with its default and allowed values.
// Settings coming from a renderer are validated against this before they are stored.

const ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', search: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?q=%s&type=list' },
  startpage: { name: 'Startpage', search: 'https://www.startpage.com/do/search?q=%s', suggest: null },
  brave: { name: 'Brave Search', search: 'https://search.brave.com/search?q=%s', suggest: 'https://search.brave.com/api/suggest?q=%s' },
  ecosia: { name: 'Ecosia', search: 'https://www.ecosia.org/search?q=%s', suggest: 'https://ac.ecosia.org/autocomplete?q=%s&type=list' },
  google: { name: 'Google', search: 'https://www.google.com/search?q=%s', suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s' },
  bing: { name: 'Bing', search: 'https://www.bing.com/search?q=%s', suggest: 'https://api.bing.com/osjson.aspx?query=%s' },
};

const LANGUAGES = {
  'en-GB': 'English (UK)', 'en-US': 'English (US)', 'nl-NL': 'Nederlands', 'de-DE': 'Deutsch', 'fr-FR': 'Français',
  'es-ES': 'Español', 'it-IT': 'Italiano', 'pt-PT': 'Português', 'pl-PL': 'Polski', 'sv-SE': 'Svenska', 'tr-TR': 'Türkçe',
  'ja-JP': '日本語', 'zh-CN': '中文 (简体)',
};

const BOOL = (d) => ({ type: 'bool', default: d });
const ENUM = (d, values) => ({ type: 'enum', default: d, values });

const SCHEMA = {
  // General
  restore: BOOL(true),
  startup: ENUM('start', ['start', 'blank']),
  downloadDir: { type: 'path', default: '' },          // '' = system Downloads (or ~/Home/Downloads on Orbit OS)
  askdl: BOOL(false),
  // Appearance
  style: ENUM('auto', ['auto', 'Glass', 'Graphite', 'Light']),
  bg: { type: 'bg', default: 'Glass' },                 // a wallpaper name, 's:#rrggbb' or 'p:<picsum id>'
  reduce: BOOL(false),
  compact: BOOL(false),
  zoom: ENUM(100, [67, 75, 80, 90, 100, 110, 125, 150, 175, 200]),
  // Privacy & security
  shield: BOOL(true),
  https: BOOL(true),
  cookies: BOOL(true),
  dnt: BOOL(true),
  webrtc: BOOL(true),
  clear: ENUM('off', ['off', 'history', 'cookies', 'all']),
  // Search
  engine: ENUM('duckduckgo', Object.keys(ENGINES)),
  suggest: BOOL(true),
  // Performance
  sleep: BOOL(true),
  memsave: BOOL(true),
  gpu: BOOL(true),
  preload: BOOL(false),
  // Accessibility
  bigtext: BOOL(false),
  contrast: BOOL(false),
  motion: BOOL(false),
  caret: BOOL(false),
  // Languages
  lang: ENUM('en-GB', Object.keys(LANGUAGES)),
  translate: BOOL(true),
  spell: BOOL(true),
  // Passwords
  save: BOOL(true),
  autofill: BOOL(false),
  // Extensions / widgets
  wNotes: BOOL(true), wDl: BOOL(true), wMedia: BOOL(true), wAds: BOOL(true), wAuth: BOOL(true), wKp: BOOL(true),
  ext1: BOOL(true),   // reader view
  ext2: BOOL(false),  // dark pages
  // Ad blocker
  ads: BOOL(true), easy: BOOL(true), annoy: BOOL(true), social: BOOL(false),
  // KeePass
  vaultPath: { type: 'path', default: '' },
};

function defaults() {
  return Object.fromEntries(Object.entries(SCHEMA).map(([k, v]) => [k, v.default]));
}

const BG_NAMES = ['Glass', 'Lagoon', 'Graphite', 'Light'];

function validate(key, value) {
  const s = SCHEMA[key];
  if (!s) throw new Error(`unknown setting ${key}`);
  switch (s.type) {
    case 'bool':
      if (typeof value !== 'boolean') throw new Error(`${key} must be true/false`);
      return value;
    case 'enum':
      if (!s.values.includes(value)) throw new Error(`${key}: ${value} is not allowed`);
      return value;
    case 'path':
      if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw new Error(`${key}: bad path`);
      return value;
    case 'bg':
      if (BG_NAMES.includes(value) || /^s:#[0-9a-fA-F]{6}$/.test(value) || /^p:\d{1,5}$/.test(value)) return value;
      throw new Error(`bg: ${value} is not allowed`);
    default:
      throw new Error(`bad schema for ${key}`);
  }
}

module.exports = { SCHEMA, ENGINES, LANGUAGES, BG_NAMES, defaults, validate };
