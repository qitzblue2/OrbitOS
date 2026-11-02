// Collects microphone audio into 100 ms chunks of 16 kHz mono float32 for the on-device speech engine,
// and evens out the volume first: quiet voices are boosted (up to 10x), loud ones are not clipped.
class PcmCollector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1600); this.n = 0;
    this.mode = 'auto'; this.manual = 1;           // 'auto' or a fixed boost
    this.gain = 1; this.speech = 0.05; this.floor = 0.002;
    this.port.onmessage = (e) => { if (e.data.boost !== undefined) { this.mode = e.data.boost === 'auto' ? 'auto' : 'manual'; this.manual = +e.data.boost || 1; } };
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.flush(); this.n = 0; }
    }
    return true;
  }
  flush() {
    const x = this.buf;
    let sum = 0; for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
    const rms = Math.sqrt(sum / x.length);
    // Track the background noise and the level of actual speech separately.
    // Background level = the quietest moments (gaps between words): falls fast, rises slowly.
    this.floor = rms < this.floor ? this.floor * 0.7 + rms * 0.3 : Math.min(this.floor * 1.01, rms);
    const speaking = rms > Math.max(this.floor * 2.5, 0.0015);
    if (speaking) this.speech = this.speech * 0.85 + rms * 0.15;
    const target = this.mode === 'auto' ? Math.max(1, Math.min(10, 0.08 / Math.max(this.speech, 1e-4))) : this.manual;
    this.gain += (target - this.gain) * 0.2; // glide, so the boost never jumps mid-word
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) { const v = x[i] * this.gain; out[i] = v > 0.9 || v < -0.9 ? Math.tanh(v) : v; } // soft limit
    this.port.postMessage({ samples: out, raw: rms, gain: this.gain, speaking }, [out.buffer]);
  }
}
registerProcessor('pcm-collector', PcmCollector);
