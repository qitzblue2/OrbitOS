// Tool calling (non-streaming) for OpenAI-compatible providers and Anthropic.
// ORBIT keeps one neutral message format and converts it per provider:
//   { role: 'user' | 'assistant', content: string, toolCalls?: [{ id, name, args }] }
//   { role: 'tool', id, name, content: string }

function toOpenAI(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.id, content: m.content });
    else if (m.role === 'assistant' && m.toolCalls?.length) out.push({ role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) });
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

function toAnthropic(messages) {
  const out = [];
  const push = (role, block) => { const last = out.at(-1); if (last && last.role === role && Array.isArray(last.content)) last.content.push(block); else out.push({ role, content: [block] }); };
  for (const m of messages) {
    if (m.role === 'tool') push('user', { type: 'tool_result', tool_use_id: m.id, content: m.content });
    else if (m.role === 'assistant') {
      if (m.content) push('assistant', { type: 'text', text: m.content });
      for (const c of m.toolCalls || []) push('assistant', { type: 'tool_use', id: c.id, name: c.name, input: c.args || {} });
    } else push('user', { type: 'text', text: m.content });
  }
  return out;
}

export async function complete({ kind, apiKey, baseUrl, model, system, messages, tools, maxTokens = 8000, signal }) {
  if (kind === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: toAnthropic(messages), tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }),
    });
    if (!res.ok) throw Object.assign(new Error(`Anthropic error ${res.status}: ${(await res.text()).slice(0, 300)}`), { status: res.status });
    const j = await res.json();
    return {
      text: j.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
      toolCalls: j.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
    };
  }
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', signal, headers,
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: toOpenAI(system, messages), tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: 'auto' }),
  });
  if (!res.ok) throw Object.assign(new Error(`error ${res.status}: ${(await res.text()).slice(0, 300)}`), { status: res.status });
  const msg = (await res.json()).choices?.[0]?.message || {};
  return {
    text: String(msg.content || '').trim(),
    toolCalls: (msg.tool_calls || []).map((c) => {
      let args = {}; try { args = typeof c.function?.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : c.function?.arguments || {}; } catch {}
      return { id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.function?.name, args };
    }),
  };
}

export const _test = { toOpenAI, toAnthropic };
