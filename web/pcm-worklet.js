// Collects microphone audio into 100 ms chunks of 16 kHz mono float32 for the on-device speech engine.
class PcmCollector extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1600); this.n = 0; }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; } }
    return true;
  }
}
registerProcessor('pcm-collector', PcmCollector);
