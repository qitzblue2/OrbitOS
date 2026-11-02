// Used when no AI key is configured. It is honest: it never invents an answer.
export class OfflineProvider {
  constructor() { this.name = 'offline'; }
  async *stream() {
    const msg = "I can't answer questions yet: add an AI key under AI configuration. I can still open apps, control your computer and lights, run routines and remember things.";
    for (const w of msg.split(/(?<= )/)) { yield w; await new Promise((r) => setTimeout(r, 12)); }
  }
}
