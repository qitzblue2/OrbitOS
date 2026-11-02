// ORBIT on-device speech: wake word, speech-to-text and text-to-speech, all running locally
// with sherpa-onnx. No audio leaves this computer for any of these steps.
//
//   audio (16 kHz mono float32) ─► KeywordSpotter ("hey orbit")
//                                    └─ wake ─► OnlineRecognizer (streaming STT + endpointing) ─► utterance
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const sherpa = require('sherpa-onnx-node');

const SAMPLE_RATE = 16000;

// BPE token spellings of the wake phrase for the gigaspeech KWS model (see "HEY SIRI" -> ▁HE Y ▁S I RI).
const WAKE_KEYWORDS = [
  '▁HE Y ▁OR B IT :2.0 #0.25 @HEY_ORBIT',
  '▁HE Y ▁O R B IT :2.0 #0.25 @HEY_ORBIT',
  '▁HI ▁OR B IT :2.0 #0.25 @HI_ORBIT',
  '▁O K ▁OR B IT :2.0 #0.25 @OK_ORBIT',
].join('\n');

// The pre-roll contains the wake phrase itself; remove however the recognizer spelled it.
function stripWake(raw) {
  const t = raw.trim().toLowerCase();
  const m = t.match(/^(?:\S+\s+){0,2}?(?:orbit|orbits|orbet|or bit|or but|orbe|\S*bit|\S*orb\S*)\b[,.]?\s*/);
  return (m ? t.slice(m[0].length) : t).replace(/^[a-z]\b\s*/, '').trim(); // drop a stray fragment like the "t" of "orbit"
}

const MODELS = {
  kws: 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01',
  asr: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
  tts: 'vits-piper-en_GB-alan-medium', // default voice, bundled
};

// On-device voices. "bundled" ship with the installer; the rest download on demand from the Voice screen.
const KOKORO = 'kokoro-int8-en-v0_19';
const VOICES = {
  alan:   { label: 'Alan', desc: 'British, calm', engine: 'piper', dir: 'vits-piper-en_GB-alan-medium', file: 'en_GB-alan-medium.onnx', bundled: true },
  lessac: { label: 'Lessac', desc: 'American, clear', engine: 'piper', dir: 'vits-piper-en_US-lessac-medium', file: 'en_US-lessac-medium.onnx', bundled: true },
  ryan:   { label: 'Ryan', desc: 'American, rich (high quality)', engine: 'piper', dir: 'vits-piper-en_US-ryan-high', file: 'en_US-ryan-high.onnx', sizeMB: 110 },
  ...Object.fromEntries([
    ['bm_george', 'George', 'British, deep'], ['bm_lewis', 'Lewis', 'British, warm'], ['bf_emma', 'Emma', 'British, bright'], ['bf_isabella', 'Isabella', 'British, soft'],
    ['am_adam', 'Adam', 'American, confident'], ['am_michael', 'Michael', 'American, relaxed'], ['af_bella', 'Bella', 'American, expressive'],
    ['af_nicole', 'Nicole', 'American, whispery'], ['af_sarah', 'Sarah', 'American, friendly'], ['af_sky', 'Sky', 'American, airy'], ['af', 'Aria', 'American, balanced'],
  ].map(([id, label, desc], i) => [`kokoro:${id}`, { label, desc: `${desc} · most natural`, engine: 'kokoro', dir: KOKORO, sid: ['af', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'am_adam', 'am_michael', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis'].indexOf(id), sizeMB: 100 }])),
};

function modelsPresent(dir) {
  return [MODELS.kws, MODELS.asr, MODELS.tts].every((m) => fs.existsSync(path.join(dir, m)));
}
// A voice can live in the bundled models folder or in the user's download folder.
function voiceDir(dirs, id) { const v = VOICES[id]; if (!v) return null; for (const d of [].concat(dirs)) if (d && fs.existsSync(path.join(d, v.dir))) return path.join(d, v.dir); return null; }
function voiceInstalled(dirs, id) { return !!voiceDir(dirs, id); }

class LocalSpeech extends EventEmitter {
  constructor(modelsDir, { sensitivity = 0.06, threads = 1, voice = 'alan', voiceDirs = [], patience = 1.0 } = {}) {
    super();
    this.voiceDirs = [modelsDir, ...voiceDirs]; this.ttsCache = new Map();
    const kd = path.join(modelsDir, MODELS.kws), ad = path.join(modelsDir, MODELS.asr);
    const keywords = WAKE_KEYWORDS.replace(/#[\d.]+/g, `#${sensitivity}`);
    const kwsFile = path.join(require('node:os').tmpdir(), 'orbit-keywords.txt');
    fs.writeFileSync(kwsFile, keywords);
    this.kws = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(kd, 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
          decoder: path.join(kd, 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
          joiner: path.join(kd, 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        },
        tokens: path.join(kd, 'tokens.txt'), numThreads: threads, provider: 'cpu', debug: 0,
      },
      keywordsFile: kwsFile,
    });
    this.asr = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(ad, 'encoder-epoch-99-avg-1.int8.onnx'),
          decoder: path.join(ad, 'decoder-epoch-99-avg-1.int8.onnx'),
          joiner: path.join(ad, 'joiner-epoch-99-avg-1.int8.onnx'),
        },
        tokens: path.join(ad, 'tokens.txt'), numThreads: threads, provider: 'cpu', debug: 0,
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: true,
      rule1MinTrailingSilence: 3.0,       // after the wake word, wait up to 3 s for you to start
      rule2MinTrailingSilence: patience,  // end of turn after this much silence (adjustable: pauses mid-sentence)
      rule3MinUtteranceLength: 20,        // hard cap per utterance
    });
    this.setVoice(voice);
    this.kwsStream = this.kws.createStream();
    this.mode = 'wake';       // wake | command
    this.asrStream = null;
    this.lastText = '';
    this.deadline = 0;        // follow-up window / no-speech timeout
    this.ptt = false;
  }

  // Feed raw microphone audio. Call continuously while the mic is enabled.
  accept(samples) {
    this.remember(samples);
    if (this.mode === 'wake') {
      // A long-running keyword spotter misses far more wake words than a fresh one
      // (measured: 6–9/24 vs 24/24 on identical audio). So every time speech starts after a
      // pause, start a fresh detector primed with the last 1.1 s of audio, and feed it from there.
      let e = 0; for (let i = 0; i < samples.length; i++) e += samples[i] * samples[i];
      const rms = Math.sqrt(e / Math.max(1, samples.length));
      this.floor = this.floor == null ? rms : rms < this.floor ? this.floor * 0.7 + rms * 0.3 : Math.min(this.floor * 1.01, rms);
      const loud = rms > Math.max(this.floor * 2.5, 0.002);
      const onset = loud && (this.quiet || 0) >= SAMPLE_RATE * 0.45;
      this.quiet = loud ? 0 : (this.quiet || 0) + samples.length;
      if (onset) {
        this.kwsStream = this.kws.createStream();
        const pre = this.preroll();
        this.kwsStream.acceptWaveform({ samples: pre.subarray(Math.max(0, pre.length - SAMPLE_RATE * 1.1)), sampleRate: SAMPLE_RATE }); // includes this chunk
      } else {
        this.kwsStream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      }

      while (this.kws.isReady(this.kwsStream)) {
        this.kws.decode(this.kwsStream);
        const r = this.kws.getResult(this.kwsStream);
        if (r.keyword) { this.kwsStream = this.kws.createStream(); this.emit('wake', r.keyword); this.startCommand({ preroll: true }); return; }
      }
      return;
    }
    this.asrStream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    if (this.cmdLen < SAMPLE_RATE * 30) { this.cmdAudio.push(Float32Array.from(samples)); this.cmdLen += samples.length; } // kept for optional cloud transcription
    while (this.asr.isReady(this.asrStream)) this.asr.decode(this.asrStream);
    const text = stripWake(this.asr.getResult(this.asrStream).text);
    if (text && text !== this.lastText) { this.lastText = text; this.deadline = 0; this.emit('partial', text.toLowerCase()); }
    if (this.ptt) return; // push-to-talk ends on release, not on silence
    if (this.asr.isEndpoint(this.asrStream) || (this.deadline && !text && Date.now() > this.deadline)) this.finishCommand();
  }

  // Ring buffer of recent audio, so words spoken right after the wake phrase are not clipped.
  remember(samples) {
    if (!this.ring) { this.ring = new Float32Array(SAMPLE_RATE * 1.2); this.ringPos = 0; }
    for (let i = 0; i < samples.length; i++) { this.ring[this.ringPos] = samples[i]; this.ringPos = (this.ringPos + 1) % this.ring.length; }
  }
  preroll() { return Float32Array.from([...this.ring.subarray(this.ringPos), ...this.ring.subarray(0, this.ringPos)]); }

  startCommand({ timeoutMs = 0, ptt = false, preroll = false } = {}) {
    this.mode = 'command'; this.ptt = ptt; this.lastText = '';
    this.asrStream = this.asr.createStream();
    this.cmdAudio = []; this.cmdLen = 0;
    if (preroll && this.ring) { const pre = this.preroll(); this.asrStream.acceptWaveform({ samples: pre, sampleRate: SAMPLE_RATE }); this.cmdAudio.push(pre); this.cmdLen = pre.length; }
    this.deadline = timeoutMs ? Date.now() + timeoutMs : 0;
    this.emit('listening', { ptt });
  }

  finishCommand() {
    if (this.mode !== 'command') return;
    const tail = new Float32Array(SAMPLE_RATE * 0.3); // flush the model with a little silence
    this.asrStream.acceptWaveform({ samples: tail, sampleRate: SAMPLE_RATE });
    this.asrStream.inputFinished();
    while (this.asr.isReady(this.asrStream)) this.asr.decode(this.asrStream);
    const text = stripWake(this.asr.getResult(this.asrStream).text);
    this.asrStream = null; this.mode = 'wake'; this.ptt = false;
    this.kwsStream = this.kws.createStream(); // fresh wake detector for the next turn
    const audio = new Float32Array(this.cmdLen); let o = 0;
    for (const c of this.cmdAudio) { audio.set(c.subarray(0, Math.min(c.length, audio.length - o)), o); o += c.length; if (o >= audio.length) break; }
    this.cmdAudio = []; this.cmdLen = 0;
    this.emit('utterance', text, audio);
  }

  // After ORBIT replies, listen briefly for a follow-up without requiring the wake word.
  followUp(ms = 8000) { if (this.mode === 'wake') this.startCommand({ timeoutMs: ms }); }
  pttStart() { this.startCommand({ ptt: true }); }
  pttEnd() { this.finishCommand(); }
  cancel() { if (this.mode === 'command') { this.asrStream = null; this.mode = 'wake'; this.ptt = false; this.kwsStream = this.kws.createStream(); } }

  // Loads a voice once and keeps it ready. Unknown or missing voices fall back to the bundled default.
  setVoice(id) {
    if (!voiceInstalled(this.voiceDirs, id)) id = 'alan';
    const v = VOICES[id], d = voiceDir(this.voiceDirs, id);
    const key = v.engine === 'kokoro' ? KOKORO : id;
    if (!this.ttsCache.has(key)) {
      const threads = Math.max(1, Math.min(4, require('node:os').cpus().length - 1));
      const model = v.engine === 'kokoro'
        ? { kokoro: { model: path.join(d, 'model.int8.onnx'), voices: path.join(d, 'voices.bin'), tokens: path.join(d, 'tokens.txt'), dataDir: path.join(d, 'espeak-ng-data') } }
        : { vits: { model: path.join(d, v.file), tokens: path.join(d, 'tokens.txt'), dataDir: path.join(d, 'espeak-ng-data') } };
      this.ttsCache.set(key, new sherpa.OfflineTts({ model: { ...model, numThreads: threads, provider: 'cpu', debug: 0 }, maxNumSentences: 1 }));
    }
    this.tts = this.ttsCache.get(key); this.voice = id; this.sid = v.sid || 0;
    return id;
  }

  // Local text-to-speech for one sentence or phrase.
  synthesize(text, { speed = 1.0 } = {}) {
    if (!this.tts) return null;
    const audio = this.tts.generate({ text, sid: this.sid, speed, enableExternalBuffer: false }); // Electron forbids external buffers
    return { samples: audio.samples, sampleRate: audio.sampleRate };
  }

  // Seconds of compute per second of speech on this machine (under ~0.5 streams smoothly).
  benchmark() {
    const t0 = Date.now(); const a = this.synthesize('Good evening. Everything is ready when you are.');
    return a ? (Date.now() - t0) / 1000 / (a.samples.length / a.sampleRate) : null;
  }
}

// Linear resampler, used when audio from a voice (22–24 kHz) has to be fed back to the 16 kHz recognizer.
function resample(x, from, to = SAMPLE_RATE) {
  if (from === to) return x;
  const r = from / to, n = Math.floor(x.length / r), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * r, j = Math.floor(p); y[i] = x[j] + ((x[j + 1] ?? x[j]) - x[j]) * (p - j); }
  return y;
}

module.exports = { resample, LocalSpeech, modelsPresent, voiceInstalled, stripWake, MODELS, VOICES, SAMPLE_RATE };
