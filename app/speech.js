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
  tts: 'vits-piper-en_GB-alan-low',
};

function modelsPresent(dir) {
  return Object.values(MODELS).every((m) => fs.existsSync(path.join(dir, m)));
}

class LocalSpeech extends EventEmitter {
  constructor(modelsDir, { sensitivity = 0.08, threads = 1 } = {}) {
    super();
    const kd = path.join(modelsDir, MODELS.kws), ad = path.join(modelsDir, MODELS.asr), td = path.join(modelsDir, MODELS.tts);
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
      rule1MinTrailingSilence: 2.0,  // nothing said yet: give up after 2 s of silence
      rule2MinTrailingSilence: 0.7,  // end of turn after 0.7 s of silence following speech
      rule3MinUtteranceLength: 15,   // hard cap per utterance
    });
    this.tts = fs.existsSync(td) ? new sherpa.OfflineTts({
      model: { vits: { model: path.join(td, 'en_GB-alan-low.onnx'), tokens: path.join(td, 'tokens.txt'), dataDir: path.join(td, 'espeak-ng-data') }, numThreads: threads, provider: 'cpu', debug: 0 },
      maxNumSentences: 1,
    }) : null;
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
      this.kwsStream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      while (this.kws.isReady(this.kwsStream)) {
        this.kws.decode(this.kwsStream);
        const r = this.kws.getResult(this.kwsStream);
        if (r.keyword) { this.kwsStream = this.kws.createStream(); this.emit('wake', r.keyword); this.startCommand({ preroll: true }); return; }
      }
      return;
    }
    this.asrStream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
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
    if (preroll && this.ring) this.asrStream.acceptWaveform({ samples: this.preroll(), sampleRate: SAMPLE_RATE });
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
    this.emit('utterance', text);
  }

  // After ORBIT replies, listen briefly for a follow-up without requiring the wake word.
  followUp(ms = 8000) { if (this.mode === 'wake') this.startCommand({ timeoutMs: ms }); }
  pttStart() { this.startCommand({ ptt: true }); }
  pttEnd() { this.finishCommand(); }
  cancel() { if (this.mode === 'command') { this.asrStream = null; this.mode = 'wake'; this.ptt = false; } }

  // Local text-to-speech. Returns 16-bit-free float samples the renderer can play directly.
  synthesize(text, { speed = 1.0 } = {}) {
    if (!this.tts) return null;
    const audio = this.tts.generate({ text, sid: 0, speed, enableExternalBuffer: false }); // Electron forbids external buffers
    return { samples: audio.samples, sampleRate: audio.sampleRate };
  }
}

module.exports = { LocalSpeech, modelsPresent, stripWake, MODELS, SAMPLE_RATE };
