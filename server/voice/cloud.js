// Cloud voices: Microsoft Azure, Cartesia, Hume and OpenAI. Each returns mono float32 samples,
// so the app plays them exactly like the on-device voice. Callers fall back to the on-device
// voice on any error, so a failed key or an empty allowance never leaves ORBIT silent.

const PERSONA = 'Calm, composed and quietly witty, like a refined personal assistant. Smooth, natural pacing.';
const timeout = () => AbortSignal.timeout(15000);

export class VoiceError extends Error {
  constructor(provider, status, detail) {
    const plain = status === 401 || status === 403 ? 'the key was rejected'
      : status === 402 || status === 429 ? 'the usage limit or free allowance has run out'
      : status === 404 ? 'that voice was not found' : `error ${status}`;
    super(`${provider}: ${plain}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
    this.status = status;
  }
}

async function check(res, provider) {
  if (!res.ok) throw new VoiceError(provider, res.status, await res.text().catch(() => ''));
  return res;
}

// ---- audio helpers ----
export function pcm16ToFloat(buf) {
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}
// Minimal WAV reader (PCM 16-bit or float 32-bit, mono or stereo -> mono).
export function decodeWav(buf) {
  const b = Buffer.from(buf);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let off = 12, fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4), body = off + 8;
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    if (id === 'data' && fmt) {
      const end = Math.min(b.length, body + (size === 0xffffffff || size === 0 ? b.length : size));
      const raw = b.subarray(body, end);
      const step = fmt.bits / 8, frames = Math.floor(raw.length / step / fmt.channels), out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const o = (i * fmt.channels + c) * step;
          sum += fmt.bits === 32 && fmt.format === 3 ? raw.readFloatLE(o) : fmt.bits === 16 ? raw.readInt16LE(o) / 32768 : 0;
        }
        out[i] = sum / fmt.channels;
      }
      return { samples: out, sampleRate: fmt.rate };
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV has no audio data');
}
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const findArray = (j) => (Array.isArray(j) ? j : Object.values(j || {}).find(Array.isArray) || []);

// ---- providers ----
export const AZURE_VOICES = [
  ['en-GB-RyanNeural', 'Ryan', 'British, composed'], ['en-GB-OllieMultilingualNeural', 'Ollie', 'British, warm'],
  ['en-GB-SoniaNeural', 'Sonia', 'British, clear'], ['en-US-AndrewMultilingualNeural', 'Andrew', 'American, natural'],
  ['en-US-BrianMultilingualNeural', 'Brian', 'American, relaxed'], ['en-US-AvaMultilingualNeural', 'Ava', 'American, expressive'],
  ['en-US-EmmaMultilingualNeural', 'Emma', 'American, friendly'], ['en-US-DavisNeural', 'Davis', 'American, deep'],
  ['en-AU-WilliamNeural', 'William', 'Australian, easygoing'],
];

export const CLOUD = {
  openai: {
    label: 'OpenAI',
    async voices() {
      return [['ash', 'Ash', 'warm, steady'], ['onyx', 'Onyx', 'deep, authoritative'], ['sage', 'Sage', 'calm, thoughtful'], ['coral', 'Coral', 'bright, friendly'], ['nova', 'Nova', 'energetic'], ['echo', 'Echo', 'smooth'], ['fable', 'Fable', 'British, storyteller'], ['alloy', 'Alloy', 'neutral'], ['shimmer', 'Shimmer', 'gentle']]
        .map(([id, label, desc]) => ({ id, label, desc }));
    },
    async speak({ key, voice, text, speed = 1, fetchImpl = fetch }) {
      const res = await check(await fetchImpl('https://api.openai.com/v1/audio/speech', {
        method: 'POST', signal: timeout(), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'pcm', speed, instructions: PERSONA }),
      }), 'OpenAI');
      return { samples: pcm16ToFloat(new Uint8Array(await res.arrayBuffer())), sampleRate: 24000 };
    },
  },

  azure: {
    label: 'Microsoft Azure',
    async voices() { return AZURE_VOICES.map(([id, label, desc]) => ({ id, label, desc })); },
    async speak({ key, extra: region, voice, text, speed = 1, fetchImpl = fetch }) {
      const lang = voice.slice(0, 5);
      const rate = `${Math.round((speed - 1) * 100) >= 0 ? '+' : ''}${Math.round((speed - 1) * 100)}%`;
      const ssml = `<speak version='1.0' xml:lang='${lang}'><voice name='${xml(voice)}'><prosody rate='${rate}'>${xml(text)}</prosody></voice></speak>`;
      const res = await check(await fetchImpl(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST', signal: timeout(),
        headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'raw-24khz-16bit-mono-pcm', 'User-Agent': 'ORBIT' },
        body: ssml,
      }), 'Azure');
      return { samples: pcm16ToFloat(new Uint8Array(await res.arrayBuffer())), sampleRate: 24000 };
    },
    async test({ key, extra: region, fetchImpl = fetch }) {
      await check(await fetchImpl(`https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, { headers: { 'Ocp-Apim-Subscription-Key': key }, signal: timeout() }), 'Azure');
    },
  },

  cartesia: {
    label: 'Cartesia',
    headers: (key) => ({ 'X-API-Key': key, 'Cartesia-Version': '2024-11-13', 'content-type': 'application/json' }),
    async voices({ key, fetchImpl = fetch }) {
      const res = await check(await fetchImpl('https://api.cartesia.ai/voices?limit=100', { headers: this.headers(key), signal: timeout() }), 'Cartesia');
      return findArray(await res.json())
        .filter((v) => !v.language || String(v.language).startsWith('en'))
        .map((v) => ({ id: v.id, label: v.name, desc: (v.description || '').slice(0, 60) }));
    },
    async speak({ key, voice, text, speed = 1, fetchImpl = fetch }) {
      const res = await check(await fetchImpl('https://api.cartesia.ai/tts/bytes', {
        method: 'POST', signal: timeout(), headers: this.headers(key),
        body: JSON.stringify({ model_id: 'sonic-2', transcript: text, language: 'en', voice: { mode: 'id', id: voice },
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
          ...(speed !== 1 ? { speed: speed > 1.1 ? 'fast' : speed < 0.9 ? 'slow' : 'normal' } : {}) }),
      }), 'Cartesia');
      return { samples: pcm16ToFloat(new Uint8Array(await res.arrayBuffer())), sampleRate: 24000 };
    },
  },

  hume: {
    label: 'Hume',
    async voices({ key, fetchImpl = fetch }) {
      const res = await check(await fetchImpl('https://api.hume.ai/v0/tts/voices?provider=HUME_AI&page_size=100', { headers: { 'X-Hume-Api-Key': key }, signal: timeout() }), 'Hume');
      return findArray(await res.json()).map((v) => ({ id: v.name || v.id, label: v.name || v.id, desc: 'Hume voice library' }));
    },
    async speak({ key, voice, text, speed = 1, fetchImpl = fetch }) {
      const res = await check(await fetchImpl('https://api.hume.ai/v0/tts/file', {
        method: 'POST', signal: timeout(), headers: { 'X-Hume-Api-Key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ utterances: [{ text, description: PERSONA, voice: { name: voice, provider: 'HUME_AI' }, ...(speed !== 1 ? { speed } : {}) }], format: { type: 'wav' } }),
      }), 'Hume');
      return decodeWav(new Uint8Array(await res.arrayBuffer()));
    },
  },
};

// Uses ORBIT's keyring: first enabled key of the provider. Returns float32 audio.
export async function cloudSpeak(keyring, voiceId, text, speed = 1, fetchImpl = fetch) {
  const [provider, ...rest] = voiceId.split(':');
  const voice = rest.join(':');
  const p = CLOUD[provider];
  const k = keyring.data.keys.find((x) => x.provider === provider && x.enabled);
  if (!p || !k) throw new Error(`No ${p?.label || provider} key`);
  return p.speak({ key: keyring.secretOf(k), extra: k.baseUrl, voice, text, speed, fetchImpl });
}

// Voice lists for every cloud provider with a key (cached 10 minutes); providers without a key are listed as locked.
const cache = new Map();
export async function cloudVoices(keyring, fetchImpl = fetch) {
  const out = [];
  for (const [provider, p] of Object.entries(CLOUD)) {
    const k = keyring.data.keys.find((x) => x.provider === provider && x.enabled);
    if (!k) { out.push({ provider, label: p.label, locked: true, voices: [] }); continue; }
    const hit = cache.get(k.id);
    if (hit && hit.at > Date.now() - 600e3) { out.push(hit.value); continue; }
    let value;
    try { value = { provider, label: p.label, voices: (await p.voices({ key: keyring.secretOf(k), extra: k.baseUrl, fetchImpl })).map((v) => ({ ...v, id: `${provider}:${v.id}` })) }; }
    catch (e) { value = { provider, label: p.label, error: e.message, voices: [] }; }
    if (!value.error) cache.set(k.id, { at: Date.now(), value });
    out.push(value);
  }
  return out;
}

export async function testVoiceKey(provider, key, extra, fetchImpl = fetch) {
  const p = CLOUD[provider];
  if (p.test) return p.test({ key, extra, fetchImpl });
  const v = await p.voices({ key, extra, fetchImpl });
  if (!v.length) throw new Error(`${p.label}: no voices available on this account`);
}
