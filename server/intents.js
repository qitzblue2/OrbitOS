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

export function parseIntent(raw, now = new Date()) {
  const clean = normalizeSpeech(stripWake(raw)).replace(/[.!?]+$/, '');
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

  // Memory
  if ((m = t.match(/^remember (?:that )?(.+)$/))) return { type: 'memory.add', text: text.slice(text.toLowerCase().indexOf(m[1])) };
  if ((m = t.match(/^forget (?:that )?(.+)$/))) return { type: 'memory.forget', text: m[1] };

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
  if (/^(?:device|system|battery) status$|^how(?:'s| is) my (?:computer|pc|battery)( doing)?$/.test(t)) return act('system.status', {}, null);

  return null;
}
