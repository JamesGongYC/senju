// The model client the swarm talks to. Used by the desktop app (solo) and the server (teams).
// One client serves every model a job uses: each request goes to the provider its model names (src/models.js).
// Anthropic is called natively; every other provider through the OpenAI-compatible adapter (src/llm-openai.js),
// which takes and returns the same Anthropic-shaped messages, so the orchestrator is the same for all of them.
import Anthropic from '@anthropic-ai/sdk';
import { resolveModel, parseKeys } from './models.js';
import { makeOpenAiClient, openAiCreate } from './llm-openai.js';

// keys: an Anthropic key (as before) or { provider: key }. config: swarm.config.json, for "models" and "providers".
// fetchImpl: for tests.
export function makeLlm(keys, config = {}, { fetchImpl } = {}) {
  const byProvider = parseKeys(keys);
  const clients = new Map();
  const anthropic = () => {
    if (!clients.has('anthropic')) {
      if (!byProvider.anthropic) throw new Error('No Anthropic API key is saved, and the model is a Claude model. Add the key, or choose a model from a provider you have a key for.');
      // Long jobs meet rate limits and blips, so retry generously (the SDK backs off between tries).
      const client = new Anthropic({ apiKey: byProvider.anthropic, maxRetries: 8, timeout: 15 * 60 * 1000 });
      // Requests that carry beta features (compaction, tool-result clearing) go through the beta endpoint.
      clients.set('anthropic', (params, opts) => (params.betas ? client.beta.messages.create(params, opts) : client.messages.create(params, opts)));
    }
    return clients.get('anthropic');
  };
  const openai = (m) => {
    const key = `${m.provider}`;
    if (!clients.has(key)) {
      const info = m.providerInfo;
      const apiKey = byProvider[m.provider] ?? (info.apiKey || null);
      if (info.keyEnv && !apiKey) throw new Error(`No ${info.label} API key is saved, and the model ${m.key} runs on ${info.label}. Add the key first.`);
      // OpenRouter asks apps to name themselves; it shows in its usage pages. The website goes along only when one
      // is set ("appUrl" in swarm.config.json, or SENJU_APP_URL): never an address that is not ours.
      const site = config.appUrl ?? process.env.SENJU_APP_URL ?? null;
      const headers = m.provider === 'openrouter' ? { 'X-Title': 'Senju', ...(site ? { 'HTTP-Referer': site } : {}), ...(info.headers ?? {}) } : (info.headers ?? {});
      clients.set(key, makeOpenAiClient({ baseURL: info.baseURL, apiKey, headers, fetchImpl }));
    }
    return clients.get(key);
  };
  const profiles = new Map();
  const profile = (model) => {
    if (!profiles.has(model)) profiles.set(model, resolveModel(model, config));
    return profiles.get(model);
  };
  return {
    profile,
    create(params, opts) {
      const m = profile(params.model);
      if (m.providerInfo.native) return anthropic()({ ...params, model: m.id }, opts);
      return openAiCreate(openai(m), m)(params, opts);
    },
  };
}
