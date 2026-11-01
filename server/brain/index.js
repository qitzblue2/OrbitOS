// The ORBIT brain: chooses a model tier, injects personality + relevant memories, streams the answer.
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAICompatProvider } from './providers/openai.js';
import { OfflineProvider } from './providers/offline.js';
import { PROVIDERS, SUGGESTED, NOT_CHAT } from './catalog.js';


export function personaPrompt({ userName, tone = 'composed', memories = [], devices = [] }) {
  return [
    `You are ORBIT, ${userName ? `${userName}'s` : 'the user\'s'} personal AI system. You run their devices, home and information.`,
    'Personality: highly intelligent, calm, composed, professional and confident; polite and occasionally dryly witty. Never verbose.',
    `Tone setting: ${tone}.`,
    'Your replies are usually spoken aloud: lead with the answer, keep it to one to three short sentences unless asked for detail, no markdown in short replies.',
    'Accuracy beats speed. If you are not sure, say so plainly. Never invent facts, sources, or results.',
    'Never claim a device action happened; actions are executed and confirmed by the system, not by you.',
    memories.length ? `Relevant things you remember about the user:\n${memories.map((m) => `- (${m.kind}) ${m.text}`).join('\n')}` : '',
    devices.length ? `Connected devices: ${devices.map((d) => `${d.name} (${d.platform}${d.online ? ', online' : ', offline'})`).join('; ')}.` : '',
  ].filter(Boolean).join('\n\n');
}

// Cheap complexity heuristic: long, multi-part, analytical or code requests go to the reasoning tier.
export function chooseTier(text, { hasImage = false } = {}) {
  if (hasImage) return 'reasoning';
  const t = text.toLowerCase();
  if (t.length > 220) return 'reasoning';
  if (/\b(why|explain|analy[sz]e|compare|plan|design|debug|code|write (?:an?|the) (?:email|essay|report|document|function|script)|step by step|pros and cons|summari[sz]e|strategy)\b/.test(t)) return 'reasoning';
  return 'fast';
}
export const needsWeb = (text) => /\b(today|latest|news|current(ly)?|right now|this week|score|weather|price|stock|search)\b/i.test(text);

export class Brain {
  constructor(aiConfig, keyring) {
    this.config = aiConfig;
    this.keyring = keyring;
    this.offline = new OfflineProvider();
  }

  client(key) {
    const p = PROVIDERS[key.provider];
    const apiKey = this.keyring.secretOf(key);
    return p.kind === 'anthropic' ? new AnthropicProvider({ apiKey }) : new OpenAICompatProvider({ apiKey, baseUrl: key.baseUrl || p.baseUrl, name: p.label });
  }

  status() {
    const r = this.keyring.data.routes;
    const keys = this.keyring.list();
    const model = (tier) => r[tier].model || PROVIDERS[r[tier].provider]?.models[tier] || '';
    const live = keys.some((k) => k.enabled);
    return {
      provider: live ? (keys.some((k) => k.enabled && k.provider === r.fast.provider) ? r.fast.provider : 'fallback') : 'offline',
      fastModel: model('fast'), reasoningModel: model('reasoning'),
      routes: r, fallback: this.keyring.data.fallback, keyCount: keys.length, activeKeys: keys.filter((k) => k.enabled && !k.coolingDown).length,
    };
  }

  // Streams an answer. Tries each candidate key in turn: a key that fails before any text arrives
  // (bad key, rate limit, outage) is cooled down and the next key or provider takes over seamlessly.
  async *answer({ text, history = [], memories = [], devices = [], persona = {}, image = null, signal, tier: forced }) {
    const tier = forced || chooseTier(text, { hasImage: !!image });
    const content = image
      ? [{ type: 'image', source: { type: 'base64', media_type: image.mediaType || 'image/png', data: image.data } }, { type: 'text', text }]
      : text;
    const messages = [...history.slice(-12), { role: 'user', content }];
    const system = personaPrompt({ ...persona, memories, devices });
    const candidates = this.keyring.candidates(tier, { needVision: !!image });
    const errors = [];
    for (const { key, model } of candidates) {
      const provider = PROVIDERS[key.provider];
      let started = false;
      try {
        for await (const delta of this.client(key).stream({
          model, system, messages, maxTokens: tier === 'reasoning' ? 2048 : 512, signal,
          webSearch: provider.webSearch && needsWeb(text),
        })) {
          if (!started) { started = true; yield { meta: { tier, model, provider: key.provider, key: key.label, failovers: errors.length } }; }
          yield { delta };
        }
        if (!started) yield { meta: { tier, model, provider: key.provider, key: key.label, failovers: errors.length } };
        this.keyring.markSuccess(key);
        return;
      } catch (e) {
        if (signal?.aborted) throw e;
        if (started) throw e; // mid-answer failure: don't splice two different answers together
        this.keyring.markFailure(key, e);
        errors.push(`${key.label}: ${e.message}`);
      }
    }
    if (candidates.length) throw new Error(`Every AI key failed. ${errors.slice(-3).join(' | ')}`);
    yield { meta: { tier, model: 'none', provider: 'offline' } };
    for await (const delta of this.offline.stream()) yield { delta };
  }

  // Live model lists from each provider you have a key for, cached for 10 minutes.
  async models() {
    this.modelCache ||= new Map();
    const out = {};
    const providers = [...new Set(this.keyring.data.keys.filter((k) => k.enabled).map((k) => k.provider))];
    await Promise.all(providers.map(async (pid) => {
      const cached = this.modelCache.get(pid);
      if (cached && cached.at > Date.now() - 600e3) { out[pid] = cached.value; return; }
      const p = PROVIDERS[pid], key = this.keyring.data.keys.find((k) => k.provider === pid && k.enabled);
      let live = [];
      try {
        const secret = this.keyring.secretOf(key);
        const res = p.kind === 'anthropic'
          ? await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(8000) })
          : await fetch(`${(key.baseUrl || p.baseUrl).replace(/\/$/, '')}/models`, { headers: secret ? { authorization: `Bearer ${secret}` } : {}, signal: AbortSignal.timeout(8000) });
        if (res.ok) live = ((await res.json()).data || []).map((m) => String(m.id).replace(/^models\//, '')).filter((id) => !NOT_CHAT.test(id));
      } catch {}
      const suggested = SUGGESTED[pid] || [];
      const ids = [...new Set([...suggested.filter((m) => !live.length || live.includes(m)), ...live.sort()])];
      const value = { label: p.label, source: live.length ? 'live' : 'suggested', models: ids.length ? ids : suggested };
      this.modelCache.set(pid, { at: Date.now(), value });
      out[pid] = value;
    }));
    return out;
  }

  // Finds a model by a loosely spoken name ("gpt four o", "sonnet", "llama 70b").
  async findModel(spoken) {
    const words = (x) => x.toLowerCase().replace(/\bfour\b/g, '4').replace(/\bthree\b/g, '3').replace(/\bfive\b/g, '5').replace(/(\d) o\b/g, '$1o').split(/[^a-z0-9.]+/).filter(Boolean);
    const want = words(spoken);
    if (!want.length) return null;
    const flat = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    let best = null;
    for (const [provider, { models }] of Object.entries(await this.models())) for (const m of models) {
      const id = flat(m);
      // Every spoken word must appear in the model id; exact and prefix matches rank higher.
      if (!want.every((w) => id.includes(flat(w)))) continue;
      const score = id === flat(spoken) ? 3 : id.startsWith(flat(want[0])) ? 2 : 1;
      if (!best || score > best.score || (score === best.score && m.length < best.model.length)) best = { provider, model: m, score };
    }
    return best;
  }

  // A tiny real request to confirm a key works.
  async test(key) {
    const t0 = performance.now();
    let out = '';
    const model = this.keyring.data.routes.fast.provider === key.provider && this.keyring.data.routes.fast.model ? this.keyring.data.routes.fast.model : PROVIDERS[key.provider].models.fast;
    for await (const d of this.client(key).stream({ model, system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'ping' }], maxTokens: 5, signal: AbortSignal.timeout(20000) })) out += d;
    return { ok: true, ms: Math.round(performance.now() - t0), model, reply: out.trim().slice(0, 40) };
  }
}
