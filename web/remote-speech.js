// Connects ORBIT's voice engine to the speech engine on the ORBIT server, over the live connection
// (used on phones, in browsers, and on the Raspberry Pi projector).
export function createRemoteSpeech({ ws, send }) {
  const handlers = {}, tts = new Map(), st = { ready: false, booted: false };
  const fire = (ch, d) => (handlers[ch] || []).forEach((f) => f(d));
  return {
    platform: 'web',
    audio: (x) => { if (ws()?.readyState === 1) ws().send(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength)); },
    setListening: (on) => send({ type: 'speech-listen', on }),
    ptt: (down) => send({ type: 'speech-ptt', down }),
    followUp: (ms) => send({ type: 'speech-followup', ms }),
    cancel: () => send({ type: 'speech-cancel' }),
    speak: (text, speed) => new Promise((res) => {
      const id = Math.random().toString(36).slice(2);
      tts.set(id, res); send({ type: 'speech-say', id, text, speed });
      setTimeout(() => { if (tts.delete(id)) res(null); }, 20000);
    }),
    getInfo: async () => { if (!st.booted && ws()?.readyState === 1) { st.booted = true; send({ type: 'speech-boot' }); } return { speechReady: st.ready }; },
    setSensitivity() {}, report() {}, setStt: async () => {}, setPatience: async () => {},
    on: (ch, f) => { (handlers[ch] ||= []).push(f); return () => {}; },
    reset() { st.ready = false; st.booted = false; },
    event(m) {
      if (m.type === 'speech-tts') {
        const done = tts.get(m.id); tts.delete(m.id); if (!done) return;
        if (!m.pcm) return done(null);
        const bin = atob(m.pcm), n = bin.length >> 1, out = new Float32Array(n);
        for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v > 32767) v -= 65536; out[i] = v / 32768; }
        return done({ samples: out, sampleRate: m.sampleRate });
      }
      const ev = m.ev, d = m.data;
      if (ev === 'ready') { st.ready = true; fire('speech-ready', d); }
      else if (ev === 'unavailable') fire('unavailable', d);
      else if (ev === 'error') fire('speech-error', d);
      else if (['wake', 'listening', 'partial', 'utterance'].includes(ev)) fire(ev, d);
    },
  };
}
