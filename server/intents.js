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

export function parseIntent(raw, now = new Date()) {
  const clean = stripWake(raw).replace(/[.!?]+$/, '');
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
  if ((m = t.match(/^(?:set )?(?:the )?volume (?:to )?(\d{1,3}) ?(?:%|percent)?$/))) return act('volume.set', { level: num(m[1]) }, `Volume at ${num(m[1])} percent.`);
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
