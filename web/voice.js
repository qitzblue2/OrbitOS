// ORBIT voice engine (browser): push-to-talk, wake phrase, end-of-speech detection, barge-in,
// streaming text-to-speech, live mic level, audible cues and an instant kill switch.
//
// Privacy: the local voice-activity detector (VAD) runs here on-device. Speech recognition uses the
// browser's speech service, which in Chrome is cloud-based; wake mode is therefore opt-in and labelled.
// A fully local wake word ("Hey Orbit") belongs in the native Companion (see docs/ARCHITECTURE.md).
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const WAKE = /\b(hey|ok|okay)?\s*orbit\b[,.!]?\s*/i;

export class Voice extends EventTarget {
  constructor() {
    super();
    this.supported = { stt: !!SR, tts: 'speechSynthesis' in window };
    this.mode = 'off';         // off | wake | ptt
    this.followUpUntil = 0;    // continuous conversation window after a reply
    this.speaking = false;
    this.voice = { name: '', rate: 1.05, pitch: 0.95 };
    this.queue = []; this.buffer = '';
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // ---- microphone + local VAD ----
  async openMic() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 1024; src.connect(this.analyser);
    const data = new Float32Array(this.analyser.fftSize);
    let floor = 0.01;
    const tick = () => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(data);
      let sum = 0; for (const v of data) sum += v * v;
      const rms = Math.sqrt(sum / data.length);
      floor = Math.min(floor * 1.0005 + 0.00001, rms < floor ? rms : floor); // adaptive noise floor
      const level = Math.min(1, Math.max(0, (rms - floor * 1.5) * 12));
      this.emit('level', level);
      // barge-in: the user starts talking while ORBIT is speaking
      if (this.speaking && level > 0.35) this.interrupt('voice');
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }
  closeMic() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close(); this.stream = this.ctx = this.analyser = null;
    this.emit('level', 0);
  }

  // ---- recognition ----
  makeRecognizer({ continuous }) {
    const r = new SR();
    r.lang = navigator.language || 'en-US'; r.interimResults = true; r.continuous = continuous; r.maxAlternatives = 1;
    return r;
  }

  async setMode(mode) {
    this.stopRecognition();
    if (mode === 'off') { this.mode = 'off'; this.closeMic(); this.emit('mode', 'off'); return; }
    if (!this.supported.stt) { this.emit('error', 'Speech recognition is not supported in this browser. Use Chrome or Edge, or type.'); return; }
    await this.openMic();
    this.mode = mode; this.emit('mode', mode);
    if (mode === 'wake') this.listenForWake();
  }

  listenForWake() {
    if (this.mode !== 'wake') return;
    const r = this.makeRecognizer({ continuous: true });
    this.rec = r;
    let command = '', silence;
    const commit = () => {
      clearTimeout(silence);
      const text = command.trim(); command = '';
      if (text) { this.followUpUntil = 0; this.emit('utterance', { text, source: 'voice' }); }
    };
    r.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i], said = res[0].transcript;
        const awake = Date.now() < this.followUpUntil;
        if (!command && !awake && !WAKE.test(said)) continue; // ignore everything until the wake phrase
        if (!command) { this.cue('wake'); this.emit('state', 'listening'); }
        const clean = said.replace(WAKE, '');
        if (res.isFinal) { command += ' ' + clean; } else interim = clean;
        this.emit('interim', (command + ' ' + interim).trim());
        if (this.speaking) this.interrupt('voice');
        clearTimeout(silence);
        silence = setTimeout(commit, res.isFinal ? 650 : 1400); // end-of-speech detection
      }
    };
    r.onerror = (e) => { if (e.error === 'not-allowed') { this.emit('error', 'Microphone permission was denied.'); this.setMode('off'); } };
    r.onend = () => { if (this.rec === r && this.mode === 'wake') setTimeout(() => this.listenForWake(), 150); };
    try { r.start(); } catch {}
  }

  // Push-to-talk: start on press, finish on release.
  async pttStart() {
    if (!this.supported.stt) { this.emit('error', 'Speech recognition is not supported in this browser.'); return; }
    if (this.speaking) this.interrupt('ptt');
    await this.openMic();
    this.stopRecognition();
    const r = this.makeRecognizer({ continuous: true });
    this.rec = r; this.pttText = '';
    r.onresult = (ev) => {
      let final = '', interim = '';
      for (let i = 0; i < ev.results.length; i++) (ev.results[i].isFinal ? (final += ev.results[i][0].transcript) : (interim += ev.results[i][0].transcript));
      this.pttText = (final + ' ' + interim).trim();
      this.emit('interim', this.pttText);
    };
    r.onend = () => { if (this.rec === r) this.rec = null; };
    this.cue('wake'); this.emit('state', 'listening');
    try { r.start(); } catch {}
  }
  pttEnd() {
    const r = this.rec; if (!r) return;
    setTimeout(() => { // let the last words finalize
      try { r.stop(); } catch {}
      const text = (this.pttText || '').replace(WAKE, '').trim();
      if (text) this.emit('utterance', { text, source: 'voice' }); else this.emit('state', 'idle');
      if (this.mode !== 'wake') { this.rec = null; if (this.mode === 'off') this.closeMic(); } else this.listenForWake();
    }, 350);
  }
  stopRecognition() { const r = this.rec; this.rec = null; try { r?.abort(); } catch {} }

  // ---- streaming speech output: speak sentence by sentence as text arrives ----
  feed(delta) {
    this.buffer += delta;
    const parts = this.buffer.split(/(?<=[.!?;:])\s+(?=[A-Z0-9"'])/);
    this.buffer = parts.pop();
    for (const p of parts) this.say(p);
  }
  flush() { if (this.buffer.trim()) this.say(this.buffer); this.buffer = ''; }
  say(text) {
    if (!this.supported.tts || !text.trim()) return;
    const u = new SpeechSynthesisUtterance(text.replace(/[*_`#>]/g, ''));
    const v = speechSynthesis.getVoices().find((x) => x.name === this.voice.name);
    if (v) u.voice = v;
    u.rate = this.voice.rate; u.pitch = this.voice.pitch;
    u.onstart = () => { this.speaking = true; this.emit('state', 'speaking'); };
    u.onend = u.onerror = () => {
      if (!speechSynthesis.pending && !speechSynthesis.speaking) {
        this.speaking = false;
        this.followUpUntil = Date.now() + 8000; // keep listening for a follow-up, no wake word needed
        this.emit('state', this.mode === 'off' ? 'idle' : 'listening-ready');
      }
    };
    speechSynthesis.speak(u);
  }
  interrupt(by) {
    if (!this.speaking && !speechSynthesis.pending) return;
    speechSynthesis.cancel(); this.buffer = ''; this.speaking = false;
    this.emit('interrupt', by);
  }
  // Instant kill switch
  killAll() { this.interrupt('kill'); this.setMode('off'); this.followUpUntil = 0; }

  cue(kind) {
    try {
      const ctx = this.ctx || new AudioContext();
      const o = ctx.createOscillator(), gn = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(kind === 'wake' ? 660 : 440, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(kind === 'wake' ? 990 : 330, ctx.currentTime + 0.12);
      gn.gain.setValueAtTime(0.0001, ctx.currentTime); gn.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02); gn.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
      o.connect(gn).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.2);
    } catch {}
  }
}

// ---------------------------------------------------------------------------------------------
// Native mode (ORBIT desktop app): wake word, speech-to-text and text-to-speech all run on this
// computer through the app's speech engine. Audio never leaves the device for these steps.
export class NativeVoice extends EventTarget {
  constructor(native) {
    super();
    this.n = native;
    this.native = true;
    this.supported = { stt: true, tts: true };
    this.mode = 'off'; this.speaking = false; this.ready = false;
    this.voice = { name: '', rate: 1.0, pitch: 1.0 };
    this.buffer = ''; this.queue = Promise.resolve(); this.sources = new Set(); this.gen = 0;
    native.on('speech-ready', () => { this.ready = true; this.emit('ready', true); });
    native.on('speech-error', (m) => this.emit('error', m));
    native.on('models', (m) => this.emit('models', m));
    native.on('wake', () => { this.cue('wake'); this.interrupt('wake'); this.emit('state', 'listening'); });
    native.on('listening', () => this.emit('state', 'listening'));
    native.on('partial', (t) => this.emit('interim', t));
    native.on('utterance', (t) => { if (t) this.emit('utterance', { text: t, source: 'voice' }); else this.emit('state', 'idle'); });
    native.on('mic', ({ enabled }) => this.setMode(enabled ? 'wake' : 'off'));
    native.on('ptt-toggle', (down) => (down ? this.pttStart() : this.pttEnd()));
    native.getInfo().then((i) => { this.ready = i.speechReady; this.info = i; this.emit('ready', this.ready); });
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  // The engine may have become ready before this page subscribed; ask it directly.
  // Waits up to 30 s while the models load, instead of failing a click made during startup.
  async ensureReady() {
    for (let i = 0; i < 120 && !this.ready; i++) {
      this.info = await this.n.getInfo(); this.ready = this.info.speechReady;
      if (!this.ready) { if (i === 0) this.emit('mode', 'starting'); await new Promise((r) => setTimeout(r, 250)); }
    }
    return this.ready;
  }

  async openMic() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    this.ctx = new AudioContext({ sampleRate: 16000 });
    await this.ctx.audioWorklet.addModule('pcm-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-collector');
    this.node.port.onmessage = (e) => {
      const x = e.data;
      let sum = 0; for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
      const level = Math.min(1, Math.sqrt(sum / x.length) * 14);
      this.emit('level', level);
      if (this.speaking) { if (level > 0.45) this.interrupt('voice'); return; } // don't feed ORBIT's own voice to the wake detector
      this.n.audio(x);
    };
    src.connect(this.node);
  }
  closeMic() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node?.disconnect(); this.stream = this.node = null;
    this.emit('level', 0);
  }
  async setMode(mode) {
    if (mode === 'off') { this.mode = 'off'; this.n.setListening(false); this.closeMic(); this.emit('mode', 'off'); return; }
    if (!(await this.ensureReady())) { this.emit('error', 'The on-device voice engine is still starting.'); return; }
    try { await this.openMic(); } catch { this.emit('error', 'Microphone access was denied.'); return; }
    this.mode = 'wake'; this.n.setListening(true); this.emit('mode', 'wake');
  }
  async pttStart() {
    if (!(await this.ensureReady())) { this.emit('error', 'The on-device voice engine is still starting.'); return; }
    this.interrupt('ptt');
    await this.openMic();
    this.n.setListening(true); this.n.ptt(true);
    this.cue('wake'); this.emit('state', 'listening');
  }
  pttEnd() {
    this.n.ptt(false);
    if (this.mode === 'off') setTimeout(() => { this.n.setListening(false); this.closeMic(); }, 400);
  }

  // Streaming speech: synthesize and play sentence by sentence, in order, as text arrives.
  feed(delta) {
    this.buffer += delta;
    const parts = this.buffer.split(/(?<=[.!?;:])\s+(?=[A-Z0-9"'])/);
    this.buffer = parts.pop();
    for (const p of parts) this.say(p);
  }
  flush() { if (this.buffer.trim()) this.say(this.buffer); this.buffer = ''; }
  say(text) {
    text = String(text).replace(/[*_`#>]/g, '').trim();
    if (!text) return;
    const gen = this.gen;
    const pending = this.n.speak(text, this.voice.rate); // synthesis starts now, in parallel with playback
    this.queue = this.queue.then(async () => {
      const audio = await pending;
      if (!audio || gen !== this.gen) return;
      await this.play(audio, gen);
    });
    this.queue.then(() => this.drained(gen));
  }
  async play({ samples, sampleRate }, gen) {
    if (!this.out) this.out = new AudioContext();
    const buf = this.out.createBuffer(1, samples.length, sampleRate);
    buf.copyToChannel(samples, 0);
    const src = this.out.createBufferSource();
    src.buffer = buf; src.connect(this.out.destination);
    this.sources.add(src);
    if (!this.speaking) { this.speaking = true; this.emit('state', 'speaking'); }
    await new Promise((r) => { src.onended = r; src.start(); });
    this.sources.delete(src);
  }
  drained(gen) {
    if (gen !== this.gen || this.sources.size) return;
    if (this.speaking) {
      this.speaking = false;
      this.emit('state', 'listening-ready');
      if (this.mode !== 'off') this.n.followUp(8000); // continue the conversation without the wake word
    }
  }
  interrupt(by) {
    if (!this.speaking && !this.sources.size) { this.buffer = ''; return; }
    this.gen++; this.buffer = '';
    for (const s of this.sources) try { s.stop(); } catch {}
    this.sources.clear(); this.speaking = false; this.queue = Promise.resolve();
    this.emit('interrupt', by);
    if (by === 'voice' && this.mode !== 'off') this.n.followUp(8000);
  }
  killAll() { this.interrupt('kill'); this.n.cancel(); this.setMode('off'); }
  cue(kind) { Voice.prototype.cue.call(this, kind); }
}

export const createVoice = () => (window.orbitNative ? new NativeVoice(window.orbitNative) : new Voice());
