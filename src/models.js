// Which models Senju can run on, and what each can do.
//
// A model is named "provider:model-id" (for example "openrouter:ricursiveai/ripple-65b-preview"), or by a bare
// Claude id ("claude-sonnet-5-5"), which means Anthropic. Anthropic models are called natively and keep every
// long-run feature. Every other provider speaks the OpenAI-compatible chat API (src/llm-openai.js).
//
// A profile says what the orchestrator may rely on: how much fits in the context, how long a reply may be,
// whether the model sees images, whether server-side compaction, caching and effort exist, and its price.
// Unknown models get a cautious profile. Override any of it in swarm.config.json:
//   "models": { "openrouter:some/model": { "context": 65536, "vision": true, "price": { "input": 0.5, "output": 1.5 } } }
// and add providers that speak the OpenAI API:
//   "providers": { "mylab": { "baseURL": "https://llm.mylab.dev/v1", "keyEnv": "MYLAB_API_KEY" } }

export const PROVIDERS = {
  // limits: where the person sets a spending limit, so a runaway job cannot run up an open-ended bill.
  anthropic: { label: 'Anthropic', native: true, keyEnv: 'ANTHROPIC_API_KEY', keyPattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/, keyHint: 'sk-ant-…', limits: 'https://console.anthropic.com/settings/limits' },
  openrouter: { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', keyPattern: /^sk-or-[A-Za-z0-9_-]{20,}$/, keyHint: 'sk-or-…', limits: 'https://openrouter.ai/settings/keys', connect: true },
  openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', keyPattern: /^sk-(proj-)?[A-Za-z0-9_-]{20,}$/, keyHint: 'sk-…', limits: 'https://platform.openai.com/settings/organization/limits' },
  together: { label: 'Together AI', baseURL: 'https://api.together.xyz/v1', keyEnv: 'TOGETHER_API_KEY', keyHint: 'your Together key' },
  groq: { label: 'Groq', baseURL: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', keyPattern: /^gsk_[A-Za-z0-9]{20,}$/, keyHint: 'gsk_…' },
  ollama: { label: 'Ollama (this Mac)', baseURL: 'http://localhost:11434/v1', keyEnv: null, keyHint: 'no key needed' },
};

// What is known about particular models. Prices are dollars per million tokens.
const CLAUDE = { vision: true, tools: true, parallelTools: true, serverContext: true, caching: true, effort: 'output_config', context: 200000, maxOutput: 64000 };
const RIPPLE = { vision: false, tools: true, parallelTools: true, context: 1048576, maxOutput: 32768, effort: 'reasoning', price: { input: 0.1, output: 0.3 } };
const KNOWN = [
  { match: /^anthropic:claude-.*opus/, profile: { ...CLAUDE, price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } } },
  { match: /^anthropic:claude-.*sonnet/, profile: { ...CLAUDE, price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } } },
  { match: /^anthropic:claude-.*haiku/, profile: { ...CLAUDE, price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } } },
  { match: /^anthropic:/, profile: CLAUDE },
  // Claude through OpenRouter: the same model, but without Anthropic's compaction and clearing.
  { match: /^openrouter:anthropic\//, profile: { vision: true, tools: true, parallelTools: true, context: 200000, maxOutput: 32000 } },
  // Ripple 65B Preview (ricursiveAI, November 2026), as OpenRouter lists it: text only, tool calling, a 1M context,
  // replies up to 131K, reasoning effort. Other providers may serve a shorter context: set it under "models".
  // On OpenRouter, a call without tools (a lead's long planning call, a summary) can be routed to Together, which
  // serves Ripple with a 131K context and rejects any request with tools. Skipping it keeps every call on a 1M
  // endpoint with tool calling ("route" is sent as OpenRouter's provider routing object).
  { match: /^openrouter:.*ripple-65b/, profile: { ...RIPPLE, route: { ignore: ['together'] } } },
  { match: /ripple-65b/, profile: RIPPLE },
  { match: /^(openai|openrouter):(openai\/)?gpt-/, profile: { vision: true, tools: true, parallelTools: true, context: 128000, maxOutput: 16384, effort: 'reasoning_effort' } },
  { match: /^(openai|openrouter):(openai\/)?o\d/, profile: { vision: true, tools: true, parallelTools: true, context: 200000, maxOutput: 32000, effort: 'reasoning_effort' } },
  { match: /^openrouter:google\/gemini/, profile: { vision: true, tools: true, parallelTools: true, context: 1000000, maxOutput: 32000 } },
];
// A model nothing is known about: tools assumed, images not, a modest context.
const UNKNOWN = { vision: false, tools: true, parallelTools: false, serverContext: false, caching: false, effort: false, context: 32768, maxOutput: 4096, price: null };

// "claude-sonnet-5-5" -> "anthropic:claude-sonnet-5-5"; "openrouter:x/y" stays.
export function modelKey(spec) {
  const s = String(spec ?? '').trim();
  if (!s) return '';
  const i = s.indexOf(':');
  if (i > 0 && /^[a-z][a-z0-9_-]*$/.test(s.slice(0, i))) return s;
  return /^claude-/.test(s) ? `anthropic:${s}` : s;
}

export function providers(config = {}) {
  const extra = Object.fromEntries(Object.entries(config.providers ?? {}).map(([name, p]) => [name, { label: p.label ?? name, keyHint: 'API key', ...p, native: false }]));
  return { ...PROVIDERS, ...extra };
}

// Everything needed to call one model: { key, provider, id, providerInfo, ...profile }. Throws on a bad name.
export function resolveModel(spec, config = {}) {
  const key = modelKey(spec);
  const i = key.indexOf(':');
  if (i <= 0) throw new Error(`Name the model with its provider, for example "openrouter:${key || 'vendor/model'}". Known providers: ${Object.keys(providers(config)).join(', ')}.`);
  const provider = key.slice(0, i), id = key.slice(i + 1);
  const info = providers(config)[provider];
  if (!info) throw new Error(`Unknown model provider "${provider}". Known: ${Object.keys(providers(config)).join(', ')}, or add it under "providers" in swarm.config.json.`);
  const known = KNOWN.find((k) => k.match.test(key))?.profile ?? {};
  const base = info.native ? CLAUDE : UNKNOWN;
  const mine = config.models?.[key] ?? config.models?.[spec] ?? {};
  const profile = { ...base, ...known, ...mine };
  if (!info.native) { profile.serverContext = false; if (profile.effort === 'output_config') profile.effort = false; }
  return { key, provider, id, providerInfo: info, ...profile };
}

// Which provider a pasted key belongs to, from its prefix, or null.
export function guessProvider(apiKey) {
  const k = String(apiKey ?? '').trim();
  for (const [name, p] of Object.entries(PROVIDERS)) if (p.keyPattern?.test(k) && !(name === 'openai' && /^sk-(ant|or)-/.test(k))) return name;
  return null;
}

export function checkKey(provider, apiKey, config = {}) {
  const p = providers(config)[provider];
  if (!p) return `Unknown provider "${provider}".`;
  const k = String(apiKey ?? '').trim();
  if (!p.keyEnv) return `${p.label} needs no key.`;
  if (k.length < 16 || /\s/.test(k)) return `That does not look like a ${p.label} API key.`;
  if (p.keyPattern && !p.keyPattern.test(k)) return `That does not look like a ${p.label} API key (${p.keyHint}).`;
  return null;
}

// The models a config runs: the lead's, the workers', and the general one.
export const modelsOf = (config) => [...new Set([config.plannerModel ?? config.model, config.workerModel ?? config.model, config.model].filter(Boolean).map(modelKey))];
export const providersOf = (config) => [...new Set(modelsOf(config).map((m) => { try { return resolveModel(m, config).provider; } catch { return null; } }).filter(Boolean))];

// Keys from the environment, by provider ({ anthropic: 'sk-ant-…', openrouter: '…' }).
export function keysFromEnv(env = process.env, config = {}) {
  const out = {};
  for (const [name, p] of Object.entries(providers(config))) if (p.keyEnv && env[p.keyEnv]) out[name] = env[p.keyEnv];
  return out;
}

// The provider keys in a .env file's text, and the text without them: { keys: { provider: key }, rest }.
// Used to move plain-text keys into the keychain. Lines that are not provider keys stay exactly as they were.
export function splitEnvKeys(text) {
  const byVar = Object.fromEntries(Object.entries(PROVIDERS).filter(([, p]) => p.keyEnv).map(([name, p]) => [p.keyEnv, name]));
  const keys = {};
  const rest = String(text ?? '').split('\n').filter((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    const provider = m && byVar[m[1]];
    const value = provider ? m[2].replace(/^["']|["']$/g, '') : '';
    if (!provider || !value) return true;
    keys[provider] = value;
    return false;
  }).join('\n');
  return { keys, rest };
}

// A saved key value: an Anthropic key on its own (from before other providers), or JSON { provider: key }.
export function parseKeys(stored) {
  if (!stored) return {};
  if (typeof stored === 'object') return { ...stored };
  const s = String(stored).trim();
  if (s.startsWith('{')) { try { return JSON.parse(s); } catch { return {}; } }
  return { anthropic: s };
}

// Do these keys cover every model the config runs? Returns the providers still missing.
export function missingKeys(config, keys) {
  return providersOf(config).filter((p) => providers(config)[p]?.keyEnv && !keys[p]);
}

// Tools a model with a small context does without: cursor styling, window plumbing, rarely needed browser extras.
// Each tool definition costs context on every call, and a desktop worker has about forty.
const LEAN_DROP = /(^|__)(set_agent_cursor_motion|set_agent_cursor_theme|get_agent_cursor_state|get_cursor_position|move_cursor|get_screen_size|get_desktop_state|set_window_frame|kill_app|verify_state|browser_emulate_media|browser_console_messages|browser_network_requests|browser_resize|browser_install|browser_handle_dialog|browser_pdf_save|browser_generate_locator|browser_start_tracing|browser_stop_tracing)$/;
export function fitTools(tools, profile) {
  if (!profile || profile.context >= 180000) return tools;
  const short = profile.context < 64000;
  return tools.filter((t) => !LEAN_DROP.test(t.name)).map((t) => {
    if (!short || !t.description || t.description.length <= 240) return t;
    return { ...t, description: `${t.description.slice(0, 237)}…` };
  });
}
