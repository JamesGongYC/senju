// The Claude client the swarm talks to. Used by the desktop app (solo) and the server (teams).
import Anthropic from '@anthropic-ai/sdk';

export function makeLlm(apiKey) {
  // Long jobs meet rate limits and blips, so retry generously (the SDK backs off between tries).
  const client = new Anthropic({ apiKey, maxRetries: 8, timeout: 15 * 60 * 1000 });
  // Requests that carry beta features (compaction, tool-result clearing) go through the beta endpoint.
  return { create: (params, opts) => params.betas ? client.beta.messages.create(params, opts) : client.messages.create(params, opts) };
}
