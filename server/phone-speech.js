// Gives phones and browsers ORBIT's own speech engine (wake word, recognition, voice) by running it
// on this server: the phone streams its microphone here and gets text and ORBIT's voice back.
// No browser or Google speech service involved.
import path from 'node:path';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MAX_ENGINES = 3; // each loaded engine uses ~150 MB of memory

export function createPhoneSpeech(cfg) {
  const root = cfg.root;
  let modelsDir = null;
  try {
    const { locate } = require(path.join(root, 'app', 'models.js'));
    modelsDir = locate([process.env.ORBIT_MODELS_DIR, path.join(root, 'models'), path.join(cfg.dataDir, 'models')]);
  } catch {}
  let running = 0;

  function attach(ws) {
    let worker = null, ready = false, listening = false;
    const pending = new Map();
    const tell = (type, data) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'speech', ev: type, data })); };

    function boot() {
      if (worker) return;
      if (!modelsDir) return tell('unavailable', 'This ORBIT server has no speech models installed.');
      if (running >= MAX_ENGINES) return tell('unavailable', 'Too many phones are using voice right now.');
      running++;
      worker = fork(path.join(root, 'app', 'speech-worker.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      worker.on('message', (m) => {
        if (m.type === 'ready') { ready = true; tell('ready', { tts: m.tts }); }
        else if (m.type === 'speech') { const done = pending.get(m.id); pending.delete(m.id); done?.(m); }
        else if (m.type === 'error') tell('error', m.message);
        else if (['wake', 'listening', 'partial', 'utterance'].includes(m.type)) tell(m.type, m.data);
      });
      worker.on('exit', () => { running--; worker = null; ready = false; for (const d of pending.values()) d(null); pending.clear(); });
      worker.send({ type: 'boot', modelsDir, sensitivity: 0.06, patience: 1.0, voice: 'alan', voiceDirs: [path.join(cfg.dataDir, 'models')] });
    }

    function onMessage(msg) {
      switch (msg.type) {
        case 'speech-boot': boot(); tell('info', { speechReady: ready, available: !!modelsDir }); break;
        case 'speech-listen': listening = !!msg.on; if (!listening) worker?.send({ type: 'cancel' }); break;
        case 'speech-ptt': if (msg.down) listening = true; worker?.send({ type: 'ptt', down: !!msg.down }); break;
        case 'speech-followup': worker?.send({ type: 'followUp', ms: msg.ms || 8000 }); break;
        case 'speech-cancel': worker?.send({ type: 'cancel' }); break;
        case 'speech-say': {
          if (!worker || !ready) { ws.send(JSON.stringify({ type: 'speech-tts', id: msg.id, pcm: null })); break; }
          const id = String(msg.id);
          pending.set(id, (m) => {
            if (ws.readyState !== 1) return;
            if (!m?.samples) return ws.send(JSON.stringify({ type: 'speech-tts', id, pcm: null }));
            const pcm = Buffer.alloc(m.samples.length * 2);
            for (let i = 0; i < m.samples.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(m.samples[i] * 32767))), i * 2);
            ws.send(JSON.stringify({ type: 'speech-tts', id, sampleRate: m.sampleRate, pcm: pcm.toString('base64') }));
          });
          worker.send({ type: 'speak', id, text: String(msg.text || '').slice(0, 1000), speed: msg.speed || 1 });
          break;
        }
      }
    }

    // Raw 16 kHz mono float32 audio from the phone's microphone.
    function onAudio(buf) {
      if (!worker || !ready || !listening) return;
      const f = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4)));
      if (f.length && f.length <= 16000) worker.send({ type: 'audio', samples: Array.from(f) });
    }

    function close() { if (worker) worker.kill(); }
    return { onMessage, onAudio, close };
  }

  return { available: () => !!modelsDir, attach };
}
