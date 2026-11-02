// Optional cloud speech recognition with Groq's Whisper models (free tier available).
// Only the spoken command is sent, after ORBIT has already been woken on-device. Any problem
// (no key, rate limit, slow network, an unreliable result) falls back to the on-device transcript.

export const GROQ_STT_MODELS = {
  'whisper-large-v3-turbo': 'Whisper large v3 turbo (fast)',
  'whisper-large-v3': 'Whisper large v3 (most accurate)',
};

// Words Whisper should expect, so names like Spotify and ORBIT come out right.
const PROMPT = 'Hey Orbit. Open Spotify. Lock my computer. Set the bedroom lights to 30 percent. Switch to GPT-4o. Start my gaming setup.';

// Whisper sometimes invents these on silence or noise.
const HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|you\.?|bye\.?|\.+|subtitles by .*|please subscribe\.?)$/i;

export function encodeWav(samples, sampleRate = 16000) {
  const n = samples.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return b;
}

function rms(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, x.length)); }

export async function groqTranscribe({ key, audio, model = 'whisper-large-v3-turbo', fetchImpl = fetch, timeoutMs = 4000 }) {
  const form = new FormData();
  form.append('file', new Blob([encodeWav(audio)], { type: 'audio/wav' }), 'command.wav');
  form.append('model', model);
  form.append('language', 'en');
  form.append('temperature', '0');
  form.append('response_format', 'json');
  form.append('prompt', PROMPT);
  const res = await fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) { const e = new Error(res.status === 429 ? 'Groq free limit reached' : res.status === 401 ? 'Groq rejected the key' : `Groq error ${res.status}`); e.status = res.status; throw e; }
  return String((await res.json()).text || '').trim();
}

// Picks the better transcript. Returns { text, source, note }.
export async function bestTranscript({ local, audio, keyring, model, fetchImpl = fetch, stripWake = (t) => t }) {
  const k = keyring?.data.keys.find((x) => x.provider === 'groq' && x.enabled);
  if (!k || !audio || audio.length < 16000 * 0.3) return { text: local, source: 'device' };
  if (!local && rms(audio) < 0.01) return { text: '', source: 'device' }; // silence: nothing to send
  try {
    const t0 = Date.now();
    const raw = await groqTranscribe({ key: keyring.secretOf(k), audio, model, fetchImpl });
    const text = stripWake(raw.toLowerCase().replace(/[“”"]/g, '').replace(/[.!?]+$/, '').trim());
    if (!text || HALLUCINATIONS.test(raw.trim())) return { text: local, source: 'device', note: 'cloud result discarded' };
    return { text, source: 'groq', ms: Date.now() - t0 };
  } catch (e) {
    return { text: local, source: 'device', note: e.message };
  }
}
