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
