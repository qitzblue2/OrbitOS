// Runs the on-device speech engine in its own process so wake-word detection never stalls the UI.
const { LocalSpeech } = require('./speech.js');

// Runs both inside the desktop app (Electron utilityProcess) and on a server (Node child_process),
// where it gives phones the same on-device speech engine.
const port = process.parentPort || {
  postMessage: (m) => process.send && process.send(m),
  on: (_ev, fn) => process.on('message', (data) => fn({ data })),
};
if (!process.parentPort) process.on('disconnect', () => process.exit(0));

let engine = null, speaker = null;
const fs = require('node:fs');
const path = require('node:path');
// Optional voice ID: a voice fingerprint (embedding) of each utterance, for checking who is speaking.
function voiceprint(audio) {
  if (!speaker || !audio || audio.length < 16000 * 0.8) return null;
  try { const st = speaker.createStream(); st.acceptWaveform({ sampleRate: 16000, samples: audio }); st.inputFinished(); return speaker.isReady(st) ? Array.from(speaker.compute(st)) : null; } catch { return null; }
}
const send = (msg) => port.postMessage(msg);

function boot({ modelsDir, sensitivity, voice, voiceDirs, patience }) {
  try {
    engine = new LocalSpeech(modelsDir, { sensitivity, voice, voiceDirs, patience });
    for (const ev of ['wake', 'listening', 'partial']) engine.on(ev, (data) => send({ type: ev, data }));
    try {
      const { MODELS } = require('./speech.js');
      const f = path.join(modelsDir, MODELS.speaker);
      if (fs.existsSync(f)) speaker = new (require('sherpa-onnx-node').SpeakerEmbeddingExtractor)({ model: f, numThreads: 1, debug: false });
    } catch {}
    engine.on('utterance', (text, audio) => send({ type: 'utterance', data: text, audio: audio?.length ? Array.from(audio) : null, voiceprint: voiceprint(audio) }));
    send({ type: 'ready', tts: !!engine.tts, voice: engine.voice });
  } catch (e) { send({ type: 'error', message: e.message }); }
}

port.on('message', ({ data: m }) => {
  if (m.type === 'boot') return boot(m);
  if (!engine) return;
  switch (m.type) {
    case 'audio': engine.accept(new Float32Array(m.samples)); break;
    case 'ptt': m.down ? engine.pttStart() : engine.pttEnd(); break;
    case 'followUp': engine.followUp(m.ms); break;
    case 'cancel': engine.cancel(); break;
    case 'setVoice': {
      try { const v = engine.setVoice(m.voice); send({ type: 'voice', voice: v, rtf: m.benchmark ? engine.benchmark() : null }); }
      catch (e) { send({ type: 'error', message: `Couldn't load that voice: ${e.message}` }); }
      break;
    }
    case 'speak': {
      let out = null;
      try { out = engine.synthesize(m.text, { speed: m.speed || 1 }); } catch (e) { send({ type: 'error', message: `Voice output failed: ${e.message}` }); }
      send({ type: 'speech', id: m.id, samples: out ? Array.from(out.samples) : null, sampleRate: out?.sampleRate });
      break;
    }
  }
});
