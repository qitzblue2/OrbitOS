// Used when no AI key is configured. It is honest: it never invents an answer.
export class OfflineProvider {
  constructor() { this.name = 'offline'; }
  async *stream() {
    const msg = "My reasoning engine isn't connected yet. Add an API key in the server's .env and I'll be able to answer that. Device commands, routines and memory still work.";
    for (const w of msg.split(/(?<= )/)) { yield w; await new Promise((r) => setTimeout(r, 12)); }
  }
}
