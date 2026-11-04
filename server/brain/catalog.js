// Every AI provider ORBIT can use. All but Anthropic speak the OpenAI-compatible chat API,
// so one adapter covers them. Add a provider by adding a line here.
export const PROVIDERS = {
  anthropic:  { label: 'Anthropic (Claude)', kind: 'anthropic', keyHint: 'sk-ant-…', keyPattern: /^sk-ant-[\w-]{20,}$/, vision: true, webSearch: true,
                models: { fast: 'claude-haiku-5-5', reasoning: 'claude-opus-5-5' }, keysUrl: 'https://console.anthropic.com' },
  openai:     { label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', keyHint: 'sk-…', keyPattern: /^sk-[\w-]{20,}$/, vision: true,
                models: { fast: 'gpt-4o-mini', reasoning: 'gpt-4o' }, keysUrl: 'https://platform.openai.com/api-keys' },
  gemini:     { label: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyHint: 'AIza…', keyPattern: /^[\w-]{30,}$/, vision: true,
                models: { fast: 'gemini-2.0-flash', reasoning: 'gemini-2.5-pro' }, keysUrl: 'https://aistudio.google.com/apikey' },
  groq:       { label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyHint: 'gsk_…', keyPattern: /^gsk_[\w]{20,}$/,
                models: { fast: 'llama-3.1-8b-instant', reasoning: 'llama-3.3-70b-versatile' }, keysUrl: 'https://console.groq.com/keys' },
  mistral:    { label: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', keyHint: 'key', keyPattern: /^[\w-]{20,}$/,
                models: { fast: 'mistral-small-latest', reasoning: 'mistral-large-latest' }, keysUrl: 'https://console.mistral.ai/api-keys' },
  xai:        { label: 'xAI (Grok)', kind: 'openai', baseUrl: 'https://api.x.ai/v1', keyHint: 'xai-…', keyPattern: /^xai-[\w-]{20,}$/, vision: true,
                models: { fast: 'grok-3-mini', reasoning: 'grok-3' }, keysUrl: 'https://console.x.ai' },
  deepseek:   { label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', keyHint: 'sk-…', keyPattern: /^sk-[\w-]{20,}$/,
                models: { fast: 'deepseek-chat', reasoning: 'deepseek-reasoner' }, keysUrl: 'https://platform.deepseek.com/api_keys' },
  openrouter: { label: 'OpenRouter (hundreds of models)', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyHint: 'sk-or-…', keyPattern: /^sk-or-[\w-]{20,}$/, vision: true,
                models: { fast: 'openai/gpt-4o-mini', reasoning: 'anthropic/claude-opus-4' }, keysUrl: 'https://openrouter.ai/keys' },
  nanogpt:    { label: 'NanoGPT (pay as you go, many models)', kind: 'openai', baseUrl: 'https://nano-gpt.com/api/v1', keyHint: 'NanoGPT API key', keyPattern: /^[\w-]{16,}$/, vision: true,
                models: { fast: 'google/gemini-flash-latest', reasoning: 'anthropic/claude-sonnet-5.5' }, keysUrl: 'https://nano-gpt.com/api' },
  nanogpt_sub:{ label: 'NanoGPT (subscription models only)', kind: 'openai', baseUrl: 'https://nano-gpt.com/api/subscription/v1', keyHint: 'NanoGPT API key', keyPattern: /^[\w-]{16,}$/,
                models: { fast: '', reasoning: '' }, keysUrl: 'https://nano-gpt.com/api',
                note: 'Lists and uses only models included in your NanoGPT subscription. To guarantee no balance charges, also set this key to "Subscription only" on nano-gpt.com.' },
  poe:        { label: 'Poe (many models, one key)', kind: 'openai', baseUrl: 'https://api.poe.com/v1', keyHint: 'Poe API key', keyPattern: /^[\w-]{20,}$/, vision: true,
                models: { fast: 'Claude-Sonnet-4.6', reasoning: 'Claude-Opus-4.7' }, keysUrl: 'https://poe.com/api/keys' },
  ollama:     { label: 'Ollama (local, free)', kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', keyHint: 'no key needed', keyOptional: true,
                models: { fast: 'llama3.2', reasoning: 'llama3.1:70b' }, keysUrl: 'https://ollama.com' },
  // Voice-only providers (text-to-speech). They never answer questions.
  azure:      { label: 'Microsoft Azure (voice)', kind: 'voice', keyHint: 'Azure Speech key', keyPattern: /^[A-Za-z0-9]{32,100}$/,
                extra: { label: 'Region', placeholder: 'eastus', pattern: /^[a-z0-9]{3,30}$/ }, models: {}, keysUrl: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices' },
  cartesia:   { label: 'Cartesia (voice)', kind: 'voice', keyHint: 'sk_car_…', keyPattern: /^[\w-]{20,}$/, models: {}, keysUrl: 'https://play.cartesia.ai/keys' },
  hume:       { label: 'Hume (voice)', kind: 'voice', keyHint: 'Hume API key', keyPattern: /^[\w-]{20,}$/, models: {}, keysUrl: 'https://platform.hume.ai/settings/keys' },
  custom:     { label: 'Other OpenAI-compatible', kind: 'openai', baseUrl: '', keyHint: 'key', keyOptional: true, needsBaseUrl: true,
                models: { fast: '', reasoning: '' } },
};

// Shown when a provider's live model list can't be fetched, and as the top picks in menus.
export const isChat = (id) => PROVIDERS[id] && PROVIDERS[id].kind !== 'voice';

export const SUGGESTED = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini', 'gpt-4.1', 'gpt-4.1-mini'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'deepseek-r1-distill-llama-70b'],
  mistral: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
  xai: ['grok-3', 'grok-3-mini'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openrouter: ['anthropic/claude-opus-4', 'openai/gpt-4o', 'google/gemini-2.5-pro', 'meta-llama/llama-3.3-70b-instruct'],
  // From NanoGPT's docs; the live list from /api/v1/models replaces these when your key works.
  nanogpt: ['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'openai/gpt-latest', 'google/gemini-flash-latest', 'google/gemini-3.1-pro-preview', 'x-ai/grok-4.7', 'deepseek/deepseek-v4-flash-latest', 'qwen/qwen3.8-max', 'moonshotai/kimi-k3.1-pro', 'z-ai/glm-5.3'],
  nanogpt_sub: ['z-ai/glm-5.3-flash', 'google/gemma4-31b-splituntied', 'qwen/qwen3.8-27b-swift'],
  // Names as used in Poe's API docs; any public Poe bot name works (type it under Other…).
  poe: ['Claude-Sonnet-4.6', 'Claude-Opus-4.7', 'GPT-5.4', 'Gemini-3.1-Pro', 'Grok-4'],
  ollama: ['llama3.2', 'llama3.1', 'qwen2.5', 'mistral'],
  custom: [],
};

// Model IDs that are not chat models (embeddings, speech, images, moderation…).
export const NOT_CHAT = /embed|whisper|tts|transcri|dall-e|image|audio|realtime|moderation|search|similarity|edit|babbage|davinci|instruct-?0|guard|rerank|vision-preview$/i;

// Preferred picks per tier, used first when they appear in the provider's real list.
export const TIER_PICKS = {
  nanogpt_sub: { fast: ['z-ai/glm-5.3-flash', 'minimax/minimax-m3.1-flash'], reasoning: ['z-ai/glm-5.2', 'moonshotai/kimi-k2.6', 'minimax/minimax-m3', 'z-ai/glm-5.1', 'moonshotai/kimi-k2.5'] },
  nanogpt: { fast: ['google/gemini-flash-latest', 'deepseek/deepseek-v4-flash-latest'], reasoning: ['anthropic/claude-sonnet-5.5', 'openai/gpt-latest', 'google/gemini-3.1-pro-preview'] },
};

// When a provider's real model list is known, pick a sensible model for each tier from it.
const PREFER = {
  fast: [/flash/i, /mini/i, /haiku/i, /instant/i, /small/i, /lite/i, /turbo/i, /8b|12b|27b|31b/i],
  reasoning: [/opus/i, /sonnet/i, /\bpro\b|-pro/i, /max/i, /large/i, /reason|think/i, /70b|72b/i, /flash/i],
};
export function pickModel(tier, ids, suggested = [], picks = []) {
  if (!ids.length) return '';
  const first = picks.find((m) => ids.includes(m));
  if (first) return first;
  // Automatic picks skip specialised community variants; you can still choose them yourself.
  const usable = ids.filter((m) => !/embed|guard|safety|tts|whisper|distill|abliterat|uncensor|cybersec|roleplay|nsfw|apex/i.test(m));
  // Go through preferences in order; within each, a suggested (well-known) model wins.
  for (const r of PREFER[tier]) {
    const hits = usable.filter((m) => r.test(m));
    if (hits.length) return hits.find((m) => suggested.includes(m)) || hits[0];
  }
  return suggested.find((m) => ids.includes(m)) || usable[0] || ids[0];
}
