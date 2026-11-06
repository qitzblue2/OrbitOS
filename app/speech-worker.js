// Runs the on-device speech engine in its own process so wake-word detection never stalls the UI.
const { LocalSpeech } = require('./speech.js');

// Runs both inside the desktop app (Electron utilityProcess) and on a server (Node child_process),
// where it gives phones the same on-device speech engine.
const port = process.parentPort || {
  postMessage: (m) => process.send && process.send(m),
  on: (_ev, fn) => process.on('message', (data) => fn({ data })),
};
if (!process.parentPort) process.on('disconnect', () => process.exit(0));

let engine = null;
const send = (msg) => port.postMessage(msg);

function boot({ modelsDir, sensitivity, voice, voiceDirs, patience }) {
  try {
    engine = new LocalSpeech(modelsDir, { sensitivity, voice, voiceDirs, patience });
    for (const ev of ['wake', 'listening', 'partial']) engine.on(ev, (data) => send({ type: ev, data }));
    engine.on('utterance', (text, audio) => send({ type: 'utterance', data: text, audio: audio?.length ? Array.from(audio) : null }));
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
