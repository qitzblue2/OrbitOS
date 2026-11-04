// Anthropic Messages API provider with streaming. Any provider exposes the same `stream()` generator.
export class AnthropicProvider {
  constructor({ apiKey }) { this.apiKey = apiKey; this.name = 'anthropic'; }
  async *stream({ model, system, messages, maxTokens = 1024, webSearch = false, signal }) {
    const body = { model, max_tokens: maxTokens, system, messages, stream: true };
    if (webSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) { const e = new Error(`Anthropic error ${res.status}: ${(await res.text()).slice(0, 300)}`); e.status = res.status; throw e; }
    const decoder = new TextDecoder();
    let buf = '';
    const { idle } = await import('./openai.js');
    for await (const chunk of idle(res.body, 90000)) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = block.split('\n').find((l) => l.startsWith('data: '));
        if (!data) continue;
        const ev = JSON.parse(data.slice(6));
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') yield ev.delta.text;
        if (ev.type === 'error') throw new Error(ev.error?.message || 'stream error');
      }
    }
  }
}
