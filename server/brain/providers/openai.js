// OpenAI-compatible chat completions with streaming. Used for OpenAI, Gemini, Groq, Mistral,
// xAI, DeepSeek, OpenRouter, Ollama and any compatible endpoint.
// Ends a stream that goes silent, instead of waiting forever.
export async function* idle(body, ms) {
  const it = body[Symbol.asyncIterator]();
  for (;;) {
    let t; const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('The model stopped responding (no data for 90 seconds).'), { status: 504 })), ms); });
    try { const r = await Promise.race([it.next(), timeout]); if (r.done) return; yield r.value; }
    finally { clearTimeout(t); }
  }
}

export class OpenAICompatProvider {
  constructor({ apiKey, baseUrl, name = 'openai' }) { this.apiKey = apiKey; this.baseUrl = baseUrl.replace(/\/$/, ''); this.name = name; }

  // Converts Anthropic-style message content (used inside ORBIT) to OpenAI format.
  static convert(messages) {
    return messages.map((m) => {
      if (typeof m.content === 'string') return m;
      return { role: m.role, content: m.content.map((p) => p.type === 'image'
        ? { type: 'image_url', image_url: { url: `data:${p.source.media_type};base64,${p.source.data}` } }
        : { type: 'text', text: p.text }) };
    });
  }

  async *stream({ model, system, messages, maxTokens = 1024, signal }) {
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.baseUrl.includes('openrouter.ai')) { headers['HTTP-Referer'] = 'https://github.com/qitzblue2/OrbitOS'; headers['X-Title'] = 'ORBIT'; }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST', headers, signal,
      body: JSON.stringify({ model, stream: true, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...OpenAICompatProvider.convert(messages)] }),
    });
    if (!res.ok) { const e = new Error(`${this.name} error ${res.status}: ${(await res.text()).slice(0, 300)}`); e.status = res.status; throw e; }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of idle(res.body, 90000)) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        if (ev.error) throw new Error(ev.error.message || 'stream error');
        const d = ev.choices?.[0]?.delta || {};
        // "Thinking" models stream their reasoning separately before the answer.
        const thought = d.reasoning_content || d.reasoning || (Array.isArray(d.reasoning_details) ? d.reasoning_details.map((r) => r.text || '').join('') : '');
        if (thought) yield { thinking: thought };
        if (d.content) yield d.content;
      }
    }
  }
}
