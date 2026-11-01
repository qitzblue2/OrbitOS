// Runs the on-device speech engine in its own process so wake-word detection never stalls the UI.
const { LocalSpeech } = require('./speech.js');

let engine = null;
const send = (msg) => process.parentPort.postMessage(msg);

function boot({ modelsDir, sensitivity }) {
  try {
    engine = new LocalSpeech(modelsDir, { sensitivity });
    for (const ev of ['wake', 'listening', 'partial', 'utterance']) engine.on(ev, (data) => send({ type: ev, data }));
    send({ type: 'ready', tts: !!engine.tts });
  } catch (e) { send({ type: 'error', message: e.message }); }
}

process.parentPort.on('message', ({ data: m }) => {
  if (m.type === 'boot') return boot(m);
  if (!engine) return;
  switch (m.type) {
    case 'audio': engine.accept(new Float32Array(m.samples)); break;
    case 'ptt': m.down ? engine.pttStart() : engine.pttEnd(); break;
    case 'followUp': engine.followUp(m.ms); break;
    case 'cancel': engine.cancel(); break;
    case 'speak': {
      let out = null;
      try { out = engine.synthesize(m.text, { speed: m.speed || 1 }); } catch (e) { send({ type: 'error', message: `Voice output failed: ${e.message}` }); }
      send({ type: 'speech', id: m.id, samples: out ? Array.from(out.samples) : null, sampleRate: out?.sampleRate });
      break;
    }
  }
});
