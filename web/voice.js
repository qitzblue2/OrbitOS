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
    native.on('missed', () => { this.cue('miss'); this.emit('state', 'idle'); this.emit('missed', true); });
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

  // Microphone preferences (which mic, noise reduction, boost), remembered on this computer.
  get micPrefs() { try { return { deviceId: '', noiseSuppression: true, boost: 'auto', ...JSON.parse(localStorage.getItem('orbit.mic') || '{}') }; } catch { return { deviceId: '', noiseSuppression: true, boost: 'auto' }; } }
  async setMicPrefs(patch) {
    const p = { ...this.micPrefs, ...patch };
    try { localStorage.setItem('orbit.mic', JSON.stringify(p)); } catch {}
    if (patch.boost !== undefined) this.node?.port.postMessage({ boost: p.boost });
    if ((patch.deviceId !== undefined || patch.noiseSuppression !== undefined) && this.stream) { this.closeMic(); await this.openMic(); }
    return p;
  }
  async listMics() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  }

  async openMic() {
    if (this.stream) return;
    const p = this.micPrefs;
    const audio = { echoCancellation: true, noiseSuppression: p.noiseSuppression, autoGainControl: true, channelCount: 1 };
    if (p.deviceId) audio.deviceId = { exact: p.deviceId };
    try { this.stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (e) {
      if (!p.deviceId) throw e;
      delete audio.deviceId; this.stream = await navigator.mediaDevices.getUserMedia({ audio }); // chosen mic unplugged: use the default
      this.emit('error', 'Your chosen microphone is not connected, so ORBIT is using the default one.');
    }
    this.ctx = new AudioContext({ sampleRate: 16000 });
    await this.ctx.audioWorklet.addModule('pcm-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-collector');
    this.node.port.postMessage({ boost: p.boost });
    this.node.port.onmessage = (e) => {
      const { samples: x, raw, gain } = e.data;
      const level = Math.min(1, raw * gain * 14);
      this.emit('level', level);
      this.emit('mic-meter', { raw, gain, level });
      if (this.speaking) { if (level > 0.45) this.interrupt('voice'); return; } // don't feed ORBIT's own voice to the wake detector
      this.n.audio(x);
    };
    src.connect(this.node);
    // Re-open automatically if the microphone is unplugged or switched.
    this.stream.getAudioTracks()[0].addEventListener('ended', () => { if (this.mode !== 'off') { this.closeMic(); this.openMic().catch(() => this.emit('error', 'The microphone was disconnected.')); } });
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

  // ---- Smooth streaming speech ----
  // Text arrives token by token. The first phrase is spoken as soon as it is complete (low latency);
  // after that, sentences are grouped into longer phrases so intonation flows across them.
  feed(delta) {
    this.buffer += delta;
    for (;;) {
      const first = !this.spokeAny;
      const min = first ? 20 : 140;
      const re = first ? /[.!?;:,](?=\s)|\n/g : /[.!?](?=\s)|\n\n/g;
      let cut = -1, m;
      while ((m = re.exec(this.buffer))) { if (m.index + 1 >= min) { cut = m.index + 1; break; } }
      if (cut < 0) break;
      this.say(this.buffer.slice(0, cut));
      this.buffer = this.buffer.slice(cut).replace(/^\s+/, '');
    }
  }
  flush() { if (this.buffer.trim()) this.say(this.buffer); this.buffer = ''; }

  static clean(text) {
    return String(text)
      .replace(/```[\s\S]*?(```|$)/g, ' I have put the code on screen. ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'a link')
      .replace(/^\s*[-*•]\s+/gm, '')
      .replace(/^\s*#+\s*/gm, '')
      .replace(/[*_~>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  say(text) {
    text = NativeVoice.clean(text);
    if (!text || !/[a-z0-9]/i.test(text)) return;
    this.spokeAny = true;
    const gen = this.gen;
    const pending = this.n.speak(text, this.voice.rate); // synthesis runs ahead, in parallel with playback
    const pause = /[?!]$/.test(text) ? 0.22 : /[.:]$/.test(text) ? 0.18 : 0.06;
    this.queue = this.queue.then(async () => {
      const audio = await pending.catch(() => null);
      if (!audio || gen !== this.gen) return;
      this.schedule(audio, pause);
    });
  }

  // Gapless playback: each phrase is placed on the audio clock right after the previous one,
  // with 8 ms fades so the joins never click.
  schedule({ samples, sampleRate }, pause) {
    if (!this.out) { this.out = new AudioContext({ latencyHint: 'playback' }); this.playHead = 0; }
    const ctx = this.out;
    const fade = Math.min(Math.floor(sampleRate * 0.008), samples.length >> 2);
    const data = Float32Array.from(samples);
    for (let i = 0; i < fade; i++) { const g = i / fade; data[i] *= g; data[data.length - 1 - i] *= g; }
    const buf = ctx.createBuffer(1, data.length, sampleRate);
    buf.copyToChannel(data, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, this.playHead || 0);
    src.start(at);
    this.playHead = at + buf.duration + pause;
    this.sources.add(src);
    if (!this.speaking) { this.speaking = true; this.emit('state', 'speaking'); }
    const gen = this.gen;
    src.onended = () => { this.sources.delete(src); this.drained(gen); };
  }
  drained(gen) {
    if (gen !== this.gen || this.sources.size || this.buffer.trim()) return;
    // Wait a beat in case the next phrase is still being synthesized.
    clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => {
      if (gen !== this.gen || this.sources.size) return;
      if (this.speaking) {
        this.speaking = false; this.spokeAny = false; this.playHead = 0;
        this.emit('state', 'listening-ready');
        if (this.mode !== 'off') this.n.followUp(8000); // continue the conversation without the wake word
      }
    }, 350);
  }
  interrupt(by) {
    if (!this.speaking && !this.sources.size) { this.buffer = ''; this.spokeAny = false; return; }
    this.gen++; this.buffer = '';
    for (const s of this.sources) try { s.stop(); } catch {}
    this.sources.clear(); this.speaking = false; this.spokeAny = false; this.playHead = 0; this.queue = Promise.resolve();
    this.emit('interrupt', by);
    if (by === 'voice' && this.mode !== 'off') this.n.followUp(8000);
  }
  killAll() { this.interrupt('kill'); this.n.cancel(); this.setMode('off'); }
  cue(kind) { Voice.prototype.cue.call(this, kind); }
}

export const createVoice = () => (window.orbitNative ? new NativeVoice(window.orbitNative) : new Voice());
