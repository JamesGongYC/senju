// Any model behind an OpenAI-compatible chat API (OpenRouter, OpenAI, Together, Groq, Ollama, Ripple…), spoken to in
// the Anthropic Messages shape the orchestrator uses everywhere. A request is translated going out and the reply
// coming back, so the orchestrator never knows the difference:
// - system blocks, user/assistant text, tool_use and tool_result blocks <-> chat messages and tool_calls;
// - images as data URLs, and images inside tool results (which a tool message cannot carry) as a user message
//   right after; for a model that cannot see images, a short note in their place;
// - finish_reason -> stop_reason, usage (with cached tokens) -> Anthropic usage;
// - Anthropic-only request features (compaction, clearing, caching, effort) dropped or mapped.
// The request is also fitted to the model's context: old tool results are shrunk first, then the oldest steps go.

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); }, { once: true });
});
const CHARS_PER_TOKEN = 3.2;   // a cautious estimate: code and JSON run denser than prose
export const estimateTokens = (value) => Math.ceil(JSON.stringify(value ?? '').length / CHARS_PER_TOKEN);
const NO_IMAGE = '[screenshot not shown: this model cannot see images. Use the text of the window or page instead.]';

const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
const dataUrl = (img) => (img?.source?.type === 'base64' ? `data:${img.source.media_type ?? 'image/png'};base64,${img.source.data}` : img?.source?.url ?? null);

// ---- Fitting the request into the model's context ----
// On a copy: shrink tool results older than the last few, then drop whole old steps (an assistant turn with the
// tool results that answer it), keeping the first message (the task) and saying what was removed.
export function fitMessages(messages, budgetTokens, fixedTokens = 0) {
  const msgs = JSON.parse(JSON.stringify(messages));
  const size = () => fixedTokens + estimateTokens(msgs);
  if (size() <= budgetTokens) return { messages: msgs, trimmed: 0 };
  const results = msgs.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  for (const [keep, head] of [[3, 600], [1, 200]]) {
    for (const m of results.slice(0, Math.max(0, results.length - keep))) {
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        const parts = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : b.content ?? [];
        b.content = parts.map((c) => (c.type === 'image' ? { type: 'text', text: '[older screenshot removed]' }
          : c.type === 'text' && c.text.length > head + 100 ? { type: 'text', text: `${c.text.slice(0, head)}\n[rest of this older result removed to fit the context]` } : c));
      }
    }
    if (size() <= budgetTokens) return { messages: msgs, trimmed: 0 };
  }
  let dropped = 0;
  // msgs[0] is the task. Drop from index 1: an assistant message and the user message after it, together.
  while (size() > budgetTokens - 150 && msgs.length > 3) {   // room for the note below
    const i = msgs[1]?.role === 'assistant' ? 1 : msgs.findIndex((m, k) => k > 0 && m.role === 'assistant');
    if (i < 1 || i >= msgs.length - 2) break;
    const n = msgs[i + 1]?.role === 'user' ? 2 : 1;
    msgs.splice(i, n);
    dropped += n;
  }
  if (dropped) {
    const note = `[${dropped} earlier messages were removed to fit this model's context. Work from what follows; look again at anything you need.]`;
    const first = msgs[0];
    first.content = typeof first.content === 'string' ? `${first.content}\n\n${note}` : [...first.content, { type: 'text', text: note }];
    // The message after the task must be the assistant's for alternation; a leading user message is merged in.
    if (msgs[1]?.role === 'user') {
      const next = msgs.splice(1, 1)[0];
      const asArr = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);
      // Tool results whose call was dropped cannot be sent: keep only their text.
      const kept = asArr(next.content).map((b) => (b.type === 'tool_result' ? { type: 'text', text: `(earlier result) ${textOf(b.content).slice(0, 400)}` } : b));
      first.content = [...asArr(first.content), ...kept];
    }
  }
  return { messages: msgs, trimmed: dropped };
}

// ---- Anthropic request -> chat request ----
export function toChat(params, profile) {
  const out = [];
  const system = typeof params.system === 'string' ? params.system : textOf(params.system);
  if (system) out.push({ role: 'system', content: system });
  const image = (b) => (profile.vision ? { type: 'image_url', image_url: { url: dataUrl(b) } } : { type: 'text', text: NO_IMAGE });
  const capText = (s) => (profile.resultChars && s.length > profile.resultChars ? `${s.slice(0, profile.resultChars)}\n[cut to fit this model's context]` : s);
  for (const m of params.messages ?? []) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text);
      // A compaction summary from an Anthropic model stays as what the agent knew.
      for (const b of m.content) if (b.type === 'compaction' && b.content) text.unshift(`Summary of the work so far: ${b.content}`);
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: 'assistant', content: text.join('\n') || (calls.length ? null : '(no reply)'), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user message: tool results first (one tool message each), then anything else as one user message.
    const later = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const parts = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : b.content ?? [];
        const text = parts.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        const pics = parts.filter((c) => c.type === 'image');
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: capText(`${b.is_error ? 'Error: ' : ''}${text}`) || (pics.length ? '(see the image below)' : 'OK') });
        if (pics.length) later.push({ type: 'text', text: profile.vision ? `Image from the ${b.tool_use_id} result above:` : NO_IMAGE }, ...(profile.vision ? pics.map(image) : []));
      } else if (b.type === 'text') later.unshift({ type: 'text', text: b.text });
      else if (b.type === 'image') later.push(image(b));
    }
    if (later.length) out.push({ role: 'user', content: later.every((p) => p.type === 'text') ? later.map((p) => p.text).join('\n') : later });
  }
  const req = { model: profile.id, messages: out, max_tokens: params.max_tokens };
  if (params.tools?.length && profile.tools !== false) {
    req.tools = params.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } } }));
    const tc = params.tool_choice?.type;
    if (tc === 'none') req.tool_choice = 'none';
    else if (tc === 'any') req.tool_choice = 'required';
    else if (tc === 'tool') req.tool_choice = { type: 'function', function: { name: params.tool_choice.name } };
    if (profile.parallelTools === false) req.parallel_tool_calls = false;
  }
  const effort = params.output_config?.effort;
  // Effort: OpenAI's reasoning_effort, or OpenRouter's reasoning object (its own reasoning text is not kept).
  const level = effort ? ({ low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' })[effort] ?? 'medium' : null;
  if (level && profile.effort === 'reasoning_effort') req.reasoning_effort = level;
  if (level && profile.effort === 'reasoning') req.reasoning = { effort: level, exclude: true };
  return req;
}

// Arguments a model wrote for a tool call, parsed; a fenced or slightly broken JSON object is repaired.
export function parseArgs(raw) {
  if (raw == null || raw === '') return { ok: true, value: {} };
  if (typeof raw === 'object') return { ok: true, value: raw };
  const s = String(raw).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  for (const attempt of [s, s.replace(/,\s*([}\]])/g, '$1'), s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)]) {
    try { const v = JSON.parse(attempt); if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v }; } catch { /* next */ }
  }
  return { ok: false, value: {} };
}

// ---- chat reply -> Anthropic reply ----
export function fromChat(body, model) {
  const choice = body.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((p) => p.text ?? '').join('') : '';
  if (text.trim()) content.push({ type: 'text', text });
  let bad = 0;
  for (const [i, c] of (msg.tool_calls ?? []).entries()) {
    const { ok, value } = parseArgs(c.function?.arguments);
    if (!ok) bad++;
    content.push({ type: 'tool_use', id: c.id || `call_${Date.now().toString(36)}_${i}`, name: c.function?.name ?? 'unknown', input: value });
  }
  const calls = content.some((b) => b.type === 'tool_use');
  const fr = choice.finish_reason;
  const stop_reason = fr === 'length' ? 'max_tokens' : calls ? 'tool_use' : fr === 'content_filter' ? 'refusal' : 'end_turn';
  const u = body.usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0;
  return {
    id: body.id, type: 'message', role: 'assistant', model,
    content, stop_reason,
    usage: { input_tokens: Math.max(0, (u.prompt_tokens ?? 0) - cached), output_tokens: u.completion_tokens ?? 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 },
    badToolArgs: bad,
  };
}

// An error that looks like the Anthropic SDK's, so the orchestrator's checks (too long, rejected) still work.
function apiError(status, body) {
  const msg = body?.error?.message ?? body?.message ?? (typeof body === 'string' ? body : JSON.stringify(body ?? {}));
  const err = new Error(`${status} ${msg}`);
  err.status = status;
  return err;
}

export function makeOpenAiClient({ baseURL, apiKey, headers = {}, fetchImpl = globalThis.fetch, maxRetries = 8, timeoutMs = 15 * 60 * 1000 }) {
  const url = `${String(baseURL).replace(/\/+$/, '')}/chat/completions`;
  async function post(body, signal) {
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res, data;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...headers },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        const raw = await res.text();
        try { data = JSON.parse(raw); } catch { data = raw; }
      } catch (err) {
        if (signal?.aborted) throw new Error('cancelled');
        if (attempt >= maxRetries) throw err;
        await sleep(Math.min(30_000, 500 * 2 ** attempt), signal);
        continue;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      // Some gateways report an upstream failure inside a 200.
      const failed = !res.ok || (data && typeof data === 'object' && data.error && !data.choices);
      if (!failed) return data;
      const status = res.ok ? Number(data.error?.code) || 502 : res.status;
      if ((status === 429 || status >= 500) && attempt < maxRetries) {
        const wait = Number(res.headers?.get?.('retry-after')) * 1000 || Math.min(30_000, 500 * 2 ** attempt);
        await sleep(wait, signal);
        continue;
      }
      throw apiError(status, data);
    }
  }
  return { post };
}

// create(params, opts) in the Anthropic shape, for one resolved model (see src/models.js).
export function openAiCreate(client, model) {
  return async (params, { signal } = {}) => {
    const maxOut = Math.min(params.max_tokens ?? 4096, model.maxOutput ?? 4096);
    // Fit: the context minus the reply's room and a margin, with tools and system counted as fixed.
    const budget = Math.floor(model.context * 0.92) - maxOut - 512;
    const fixed = estimateTokens(params.system) + estimateTokens(params.tools);
    const { messages, trimmed } = fitMessages(params.messages ?? [], budget, fixed);
    const profile = { ...model, resultChars: Math.max(4000, Math.floor(model.context * CHARS_PER_TOKEN * 0.15)) };
    const req = toChat({ ...params, messages, max_tokens: maxOut }, profile);
    let reply = fromChat(await client.post(req, signal), model.key);
    // Tool arguments that are not JSON: ask once more before handing back an empty call.
    if (reply.badToolArgs) {
      const again = fromChat(await client.post(req, signal), model.key);
      if (!again.badToolArgs) {
        again.usage.input_tokens += reply.usage.input_tokens; again.usage.output_tokens += reply.usage.output_tokens;
        reply = again;
      }
    }
    if (trimmed) reply.trimmed = trimmed;
    return reply;
  };
}
