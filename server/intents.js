// Local intent parser: handles common commands in microseconds, with no AI call.
// Returns null when the request needs the AI brain.

const WAKE = /^\s*(hey\s+|ok\s+|okay\s+)?orbit[,.!:]?\s*/i;
export const stripWake = (t) => t.replace(WAKE, '').trim();

const DEVICE_HINT = /\b(?:on|to)\s+(?:my|the)\s+([\w' -]+?)\s*$/i;

function target(text) {
  const m = text.match(DEVICE_HINT);
  return m ? { hint: m[1].trim(), text: text.slice(0, m.index).trim() } : { hint: null, text };
}

const num = (s) => { const n = parseInt(s, 10); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null; };

// Speech recognizers misspell names they rarely hear ("spotti", "computere"). Snap words that are
// close to ORBIT's command vocabulary back to the right spelling. Short words are left alone.
const VOCAB = ['spotify', 'chrome', 'discord', 'steam', 'netflix', 'firefox', 'safari', 'slack', 'terminal', 'computer', 'laptop', 'screenshot', 'volume', 'lights', 'lighting', 'thermostat', 'temperature', 'bedroom', 'kitchen', 'living', 'office', 'routine', 'remember', 'percent', 'desktop', 'music', 'unmute'];
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const MISHEARD = { spotty: 'spotify', spotti: 'spotify', spottie: 'spotify', spottify: 'spotify', 'spot if i': 'spotify', 'crome': 'chrome', 'nets flix': 'netflix' };
const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// "thirty five per cent" -> "35 percent", "a hundred" -> "100"
export function wordsToNumbers(text) {
  return text
    .replace(/\bper ?cent\b/gi, 'percent')
    .replace(/\b(?:a |one )?hundred\b/gi, '100')
    .replace(new RegExp(`\\b(${Object.keys(TENS).join('|')})(?:[ -](${Object.keys(ONES).filter((k) => ONES[k] > 0 && ONES[k] < 10).join('|')}))?\\b`, 'gi'), (_, t, o) => String(TENS[t.toLowerCase()] + (o ? ONES[o.toLowerCase()] : 0)))
    .replace(new RegExp(`\\b(${Object.keys(ONES).join('|')})\\b(?=\\s*(?:percent|degrees|%))`, 'gi'), (w) => String(ONES[w.toLowerCase()]));
}
export function normalizeSpeech(text) {
  for (const [k, v] of Object.entries(MISHEARD)) text = text.replace(new RegExp(`\\b${k}\\b`, 'gi'), v);
  text = wordsToNumbers(text);
  return text.replace(/[A-Za-z]{5,}/g, (w) => {
    const lw = w.toLowerCase();
    if (VOCAB.includes(lw)) return w;
    let best = null, bd = 3;
    for (const v of VOCAB) { const dd = distance(lw, v); if (dd < bd && dd <= Math.max(1, Math.floor(v.length / 4))) { best = v; bd = dd; } }
    return best || w;
  });
}

// Removes polite wrappers so "can you please open Spotify for me" works like "open Spotify".
const LEAD = /^(?:(?:can|could|would|will) you(?: please)?|please|kindly|just|go ahead and|i (?:want|need|would like) you to|i'?d like you to|i want to|i'?d like to|let'?s|hey|ok|okay)[,\s]+/i;
const TRAIL = /[,\s]+(?:for me|please|now|right now|thanks|thank you|orbit|if you can|real quick)$/i;
export function simplify(text) {
  let t = text.trim().replace(/[.!?]+$/, '');
  for (let i = 0; i < 4; i++) { const before = t; t = t.replace(LEAD, '').replace(TRAIL, '').replace(/[.!?]+$/, '').trim(); if (t === before) break; }
  return t;
}

// Spoken arithmetic: "what is 1 plus 1", "15 percent of 80", "square root of 81", "12 times 7".
// Answered instantly on the device; no AI needed. Evaluated by a tiny parser (never eval()).
export function spokenMath(t) {
  let x = t.toLowerCase().replace(/^(?:what(?:'s| is)|whats|how much is|calculate|compute|work out|what does)\s+/, '').replace(/\s*(?:equal|equals|make|come to)\s*$/, '').replace(/[?=]$/, '').trim();
  x = x.replace(new RegExp(`\\b(${Object.keys(ONES).join('|')})\\b`, 'g'), (w) => String(ONES[w])).replace(/\b(\d+) point (\d+)\b/g, '$1.$2');
  let m;
  if ((m = x.match(/^(?:the )?square root of (\d+(?:\.\d+)?)$/))) return fmt(Math.sqrt(+m[1]));
  if ((m = x.match(/^(\d+(?:\.\d+)?) ?(?:%|percent) of (\d+(?:\.\d+)?)$/))) return fmt((+m[1] * +m[2]) / 100);
  if ((m = x.match(/^(\d+(?:\.\d+)?) (squared|cubed)$/))) return fmt(Number(m[1]) ** (m[2] === 'squared' ? 2 : 3));
  x = x.replace(/,(?=\d{3})/g, '').replace(/\bmultiplied by\b|\btimes\b|×|\bx\b/g, '*').replace(/\bdivided by\b|\bover\b|÷/g, '/')
    .replace(/\bplus\b|\band\b/g, '+').replace(/\bminus\b|\btake away\b/g, '-').replace(/\s+/g, ' ').trim();
  if (!/^[\d.+\-*/() ]+$/.test(x) || !/[+\-*/]/.test(x) || !/\d/.test(x)) return null;
  const tok = x.match(/\d+(?:\.\d+)?|[+\-*/()]/g); let i = 0;
  const num = () => { const k = tok[i++]; if (k === '(') { const v = sum(); i++; return v; } if (k === '-') return -num(); return +k; };
  const prod = () => { let v = num(); while (tok[i] === '*' || tok[i] === '/') { const op = tok[i++], r = num(); v = op === '*' ? v * r : v / r; } return v; };
  const sum = () => { let v = prod(); while (tok[i] === '+' || tok[i] === '-') { const op = tok[i++], r = prod(); v = op === '+' ? v + r : v - r; } return v; };
  try { const v = sum(); return i === tok.length && Number.isFinite(v) ? fmt(v) : null; } catch { return null; }
}
const fmt = (v) => String(Math.round(v * 1e6) / 1e6);

export function parseIntent(raw, now = new Date()) {
  const clean = simplify(normalizeSpeech(stripWake(raw)));
  if (!clean) return { type: 'greeting' };
  const { hint, text } = target(clean);
  const t = text.toLowerCase();
  let m;

  // Conversation control
  if (/^(stop|cancel|never ?mind|shut up|be quiet|silence)$/.test(t)) return { type: 'stop' };
  if (/^(stop|disable|turn off) (listening|the mic(rophone)?)$/.test(t)) return { type: 'mic.off' };

  // Instant local answers
  if (/^what(?:'s| is) the time|^what time is it/.test(t))
    return { type: 'local', answer: `It's ${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` };
  if (/^what(?:'s| is) (?:the |today's )?date|^what day is (?:it|today)/.test(t))
    return { type: 'local', answer: `It's ${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}.` };

  { const ans = spokenMath(t); if (ans != null) return { type: 'local', answer: `${ans}.`, math: true }; }

  // Memory
  if ((m = t.match(/^remember (?:that )?(.+)$/))) return { type: 'memory.add', text: text.slice(text.toLowerCase().indexOf(m[1])) };
  if ((m = t.match(/^forget (?:that )?(.+)$/))) return { type: 'memory.forget', text: m[1] };

  // AI model switching ("switch to GPT-4o", "use Claude Sonnet", "change the model to Llama 70b")
  if ((m = t.match(/^(?:switch|change|set) (?:the |your )?(?:ai |brain )?(?:model )?to (.+)$/)) || (m = t.match(/^use (.+?)(?: model| for everything)?$/)))
    if (!/\b(lights?|volume|thermostat|computer|pc|laptop|mode|routine|speakers?|audio|sound|headphones)\b/.test(m[1])) return { type: 'model.switch', name: m[1] };
  if (/^(?:which|what) (?:ai )?model (?:are you|is this|am i)(?: using| on)?$/.test(t)) return { type: 'model.which' };

  // Briefing
  if (/^(good morning|morning briefing|daily briefing|brief me|what's my day( look like)?)$/.test(t)) return { type: 'briefing' };

  // Routines ("start my gaming setup", "activate movie mode", "run focus routine")
  if ((m = t.match(/^(?:start|activate|run|launch|begin|enable) (?:my |the )?(.+?) (?:mode|setup|routine|scene|workflow|environment)$/)))
    return { type: 'routine', name: m[1].trim() };

  // Smart home lights
  if ((m = t.match(/^(?:turn|switch) (on|off) (?:all )?(?:the |my )?lights?(?: in (?:the |my )?(.+))?$/)) ||
      (m = t.match(/^(?:turn|switch) (?:all )?(?:the |my )?(?:(.+?) )?lights? (on|off)$/))) {
    const on = m[1] === 'on' || m[2] === 'on';
    const area = [m[1], m[2]].find((x) => x && x !== 'on' && x !== 'off') || null;
    return { type: 'home.lights', on, area };
  }
  if ((m = t.match(/^(?:set|dim|change) (?:the |my )?(?:(.+?) )?(?:lights?|lighting) (?:to )?(\d{1,3}) ?(?:%|percent)$/)))
    return { type: 'home.lights', on: true, brightness: num(m[2]), area: m[1] || null };
  if ((m = t.match(/^what(?:'s| is) the temperature(?: in (?:the |my )?(.+))?$/))) return { type: 'home.temperature', area: m[1] || null };
  if ((m = t.match(/^set (?:the )?(?:thermostat|heating|temperature) to (\d{1,2}(?:\.\d)?)(?: degrees)?$/))) return { type: 'home.thermostat', value: Number(m[1]) };

  // Weather (Open-Meteo, no key) and "show me" cards for the projector
  if ((m = t.match(/^(?:set|change) my (?:location|city|town) to (.+)$/)) || (m = t.match(/^i live in (.+)$/))) return { type: 'location.set', name: text.slice(t.indexOf(m[1])) };
  if (/^(?:show|put up|display)(?: me)? (?:the )?weather(?: (?:for )?(?:this|the) week| forecast)?(?: on the (?:wall|projector|screen))?$|^(?:what(?:'s| is) the )?weather (?:for )?(?:this|the) week$|^weekly forecast$/.test(t)) return { type: 'weather', show: true };
  if (/^(?:what(?:'s| is)|how(?:'s| is)) (?:the )?weather(?: like)?(?: today| outside| now)?$|^(?:is it|will it) (?:going to )?(?:rain|snow|be cold|be hot|be sunny)(?: today)?$|^weather$|^do i need (?:a jacket|an umbrella)$/.test(t)) return { type: 'weather', show: false };
  if (/^(?:show|put up|display)(?: me)? my (?:to-?do(?: list)?|todo(?: list)?|reminders|tasks)(?: on the (?:wall|projector|screen))?$|^what(?:'s| is) on my (?:to-?do|todo) list$/.test(t)) return { type: 'reminders.show' };
  if (/^(?:hide|clear|close) (?:it|that|the (?:screen|projector|display|card))$/.test(t)) return { type: 'project.clear' };

  // ORBIT's own machine (the Raspberry Pi)
  if (/^how(?:'s| is) (?:the |my )?(?:pi|raspberry pi|orbit|server)(?: doing| holding up)?$|^(?:pi|orbit|server) (?:health|status)$|^how hot is (?:the |my )?(?:pi|raspberry pi)$|^(?:show|check)(?: me)? (?:the )?(?:pi|raspberry pi)(?:'s)? (?:health|status|temperature)$/.test(t)) return { type: 'health', show: /^show/.test(t) };

  // Camera ("what am I holding?")
  if (/^what am i holding(?: up)?$|^what(?: do| can) you see$|^look at this$|^what(?:'s| is) (?:this|in front of you|in my hand)$|^what(?:'s| is) this (?:thing|object)$/.test(t)) return { type: 'camera.look', question: clean };

  // Intercom ("tell the desk dinner's ready", "announce dinner's ready")
  if ((m = t.match(/^announce(?: that)? (.+)$/))) return { type: 'intercom', room: null, message: text.slice(t.indexOf(m[1])) };
  if ((m = t.match(/^(?:tell|say to|message) (?:the )?([a-z][\w' ]{1,30}?)[,:]? (?:that )?(.+)$/)) && !/^(?:me|us|him|her|them|a|an|my|everyone|everybody)$/.test(m[1])) return { type: 'intercom', room: m[1], message: text.slice(t.indexOf(m[2], m[1].length)) };

  // Bluetooth speakers on the ORBIT machine
  if (/^(?:pair|add|set up) (?:a |my |the )?(?:new )?(?:bluetooth )?(?:speaker|headphones|earbuds)$/.test(t)) return { type: 'bt', action: 'pair' };
  if ((m = t.match(/^(?:connect|switch|play)(?: to| through| on)? (?:the |my )?(?:bluetooth )?(?:speaker|headphones|earbuds)(?: (?:called |named )?(.+))?$/)) || (m = t.match(/^(?:connect|switch)(?: to)? (?:the |my )?(.+?) speaker$/))) return { type: 'bt', action: 'connect', name: m[1] || null };
  if (/^(?:disconnect|turn off) (?:the |my )?(?:bluetooth )?(?:speaker|headphones|earbuds)$|^use (?:the |my )?(?:pi|built-in|normal|projector) (?:speaker|audio|sound)$/.test(t)) return { type: 'bt', action: 'disconnect' };

  // Spotify (needs Spotify connected in Settings; playback control needs Spotify Premium)
  if (/^play (?:my )?(?:liked|favou?rite|saved) songs$/.test(t)) return { type: 'spotify', action: 'liked', hint };
  if ((m = t.match(/^play (?:the )?(?:playlist|album|artist|song|track)? ?(.+?) on spotify$/))) return { type: 'spotify', action: 'play', query: m[1], kind: (t.match(/^play (?:the )?(playlist|album|artist|song|track)/) || [])[1] || null, hint };
  if ((m = t.match(/^play (?:the )?(playlist|album|artist) (.+)$/))) return { type: 'spotify', action: 'play', query: m[2], kind: m[1], hint };
  if ((m = t.match(/^(?:what(?:'s| is)|which song is) (?:this song|playing|this)(?: called)?$/))) return { type: 'spotify', action: 'now' };

  // Voice ID
  if (/^(?:learn|remember|recogni[sz]e) my voice$|^(?:set up|enrol+) (?:my )?voice(?: id)?$/.test(t)) return { type: 'voiceid.enroll' };

  // Device actions
  const act = (capability, params, speak) => ({ type: 'action', capability, params, hint, speak });

  if ((m = t.match(/^(?:open|launch|start) (.+?) and search(?: for)? (.+)$/))) return act('browser.search', { browser: m[1], query: text.slice(t.indexOf(m[2])) }, `Searching for ${m[2]}.`);
  if ((m = t.match(/^(?:search|google|look up)(?: the web)?(?: for)? (.+)$/))) return act('browser.search', { query: text.slice(t.indexOf(m[1])) }, `Searching for ${m[1]}.`);
  if ((m = t.match(/^(?:open|play) (spotify|music)(?: and play(?: my)? music)?$/)) && /play/.test(t)) return { type: 'chain', steps: [act('app.open', { app: 'spotify' }), act('media.control', { action: 'play' })], speak: 'Spotify is playing.' };
  if ((m = t.match(/^(?:open|launch|start|run) (?:the )?(.+?)(?: app)?$/)) && !/\b(mode|setup|routine|environment)\b/.test(t)) return act('app.open', { app: m[1] }, `Opening ${m[1]}.`);
  if ((m = t.match(/^(?:close|quit|exit|kill) (?:the )?(.+?)(?: app)?$/))) return act('app.close', { app: m[1] }, `Closing ${m[1]}.`);
  if ((m = t.match(/^(?:set |turn )?(?:the |my )?volume (?:to |at )?(\d{1,3}) ?(?:%|percent)?$/))) return act('volume.set', { level: num(m[1]) }, `Volume at ${num(m[1])} percent.`);
  if (/^(?:turn|put) (?:my |the )?volume down$|^(?:lower|decrease) (?:the )?volume$|^quieter$/.test(t)) return act('volume.set', { delta: -15 }, 'Volume down.');
  if (/^(?:turn|put) (?:my |the )?volume up$|^(?:raise|increase) (?:the )?volume$|^louder$/.test(t)) return act('volume.set', { delta: 15 }, 'Volume up.');
  if (/^mute$|^mute (?:the )?(?:sound|volume|audio)$/.test(t)) return act('volume.set', { mute: true }, 'Muted.');
  if (/^(?:unmute)/.test(t)) return act('volume.set', { mute: false }, 'Unmuted.');
  if (/^(?:pause|resume|play)(?: (?:the )?(?:music|media|song))?$/.test(t)) return act('media.control', { action: t.startsWith('pause') ? 'pause' : 'play' }, null);
  if (/^(?:next|skip)(?: (?:song|track))?$/.test(t)) return act('media.control', { action: 'next' }, null);
  if (/^(?:previous|last|go back)(?: (?:song|track))?$/.test(t)) return act('media.control', { action: 'previous' }, null);
  if (/^(?:take a )?screenshot$|^capture (?:my |the )?screen$/.test(t)) return act('screen.capture', {}, 'Screenshot taken.');
  if (/^(?:show me )?what(?:'s| is) on my (?:screen|desktop)$|^look at my screen$|^why isn't this working$|^what(?:'s| is) wrong (?:here|with this)$/.test(t))
    return { ...act('screen.capture', { analyze: true }), analyzeQuestion: clean };
  if (/^lock (?:my |the )?(?:computer|pc|laptop|mac|screen|device)$/.test(t)) return act('system.lock', {}, 'Locked.');
  if (/^(?:shut ?down|turn off|power off) (?:my |the )?(?:computer|pc|laptop|mac)$/.test(t)) return act('system.shutdown', { mode: 'shutdown' }, 'Shutting down.');
  if (/^restart (?:my |the )?(?:computer|pc|laptop|mac)$/.test(t)) return act('system.shutdown', { mode: 'restart' }, 'Restarting.');
  if (/^turn on (?:my |the )?(?:computer|pc)$|^wake (?:up )?(?:my |the )?(?:computer|pc)$/.test(t)) return { type: 'wake.device', hint };
  if ((m = t.match(/^(?:send|text) (?:a )?(?:message )?(?:to )?(.+?) (?:saying|that) (.+)$/))) return act('message.send', { to: m[1], body: text.slice(t.indexOf(m[2])) }, `Message sent to ${m[1]}.`);
  if (/^(?:(?:check|show|get|tell me|give me|what(?:'s| is))(?: me)? )?(?:my |the )?(?:device|system|computer|pc|laptop|mac|battery)(?:'s)? (?:status|health|stats|info|level|life)$|^(?:device|system|battery) status$|^how(?:'s| is) my (?:computer|pc|laptop|mac|battery)(?: doing| holding up)?$|^how much battery(?: do i have| is left)?(?: left)?$/.test(t)) return act('system.status', {}, null);

  return null;
}
