// The ORBIT brain: chooses a model tier, injects personality + relevant memories, streams the answer.
import { AnthropicProvider } from './providers/anthropic.js';
import { OfflineProvider } from './providers/offline.js';

const PROVIDERS = { anthropic: AnthropicProvider, offline: OfflineProvider };

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
  constructor(aiConfig) {
    this.config = aiConfig;
    this.setProvider(aiConfig.provider);
  }
  setProvider(name) {
    const Impl = PROVIDERS[name] || OfflineProvider;
    this.provider = name === 'anthropic' && !this.config.anthropicKey ? new OfflineProvider() : new Impl({ apiKey: this.config.anthropicKey });
    this.config.provider = this.provider.name;
  }
  modelFor(tier) { return tier === 'reasoning' ? this.config.reasoningModel : this.config.fastModel; }
  status() { return { provider: this.provider.name, fastModel: this.config.fastModel, reasoningModel: this.config.reasoningModel }; }

  async *answer({ text, history = [], memories = [], devices = [], persona = {}, image = null, signal }) {
    const tier = chooseTier(text, { hasImage: !!image });
    const model = this.modelFor(tier);
    const content = image
      ? [{ type: 'image', source: { type: 'base64', media_type: image.mediaType || 'image/png', data: image.data } }, { type: 'text', text }]
      : text;
    const messages = [...history.slice(-12), { role: 'user', content }];
    yield { meta: { tier, model, provider: this.provider.name } };
    for await (const delta of this.provider.stream({
      model, system: personaPrompt({ ...persona, memories, devices }), messages,
      maxTokens: tier === 'reasoning' ? 2048 : 512, webSearch: needsWeb(text) && this.provider.name === 'anthropic', signal,
    })) yield { delta };
  }
}
