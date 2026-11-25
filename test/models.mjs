// Models beyond Claude: profiles, the OpenAI-compatible adapter, fitting into a small context, keys per
// provider, billing per model, and a whole job run on a non-Anthropic model through a fake chat API.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveModel, modelKey, guessProvider, checkKey, parseKeys, missingKeys, fitTools, keysFromEnv } from '../src/models.js';
import { toChat, fromChat, parseArgs, fitMessages, estimateTokens } from '../src/llm-openai.js';
import { makeLlm } from '../src/llm.js';
import { costMicro, pricing } from '../server/billing.js';
import { Swarm } from '../src/orchestrator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RIPPLE = 'openrouter:ricursiveai/ripple-65b-preview';

// ---- Profiles ----
{
  const claude = resolveModel('claude-sonnet-5-5');
  assert.equal(claude.provider, 'anthropic');
  assert.equal(claude.key, 'anthropic:claude-sonnet-5-5');
  assert.ok(claude.serverContext && claude.vision && claude.providerInfo.native);
  const ripple = resolveModel(RIPPLE);
  assert.equal(ripple.provider, 'openrouter');
  assert.equal(ripple.id, 'ricursiveai/ripple-65b-preview');
  assert.equal(ripple.vision, false, 'Ripple is text only');
  assert.equal(ripple.serverContext, false);
  assert.equal(ripple.context, 1048576);
  assert.deepEqual(ripple.price, { input: 0.1, output: 0.3 });
  const unknown = resolveModel('together:someone/new-model');
  assert.equal(unknown.context, 32768, 'an unknown model gets a cautious profile');
  assert.equal(unknown.vision, false);
  const mine = resolveModel(RIPPLE, { models: { [RIPPLE]: { context: 16384, vision: true } } });
  assert.equal(mine.context, 16384, 'settings override a profile');
  assert.equal(mine.vision, true);
  const custom = resolveModel('mylab:big', { providers: { mylab: { baseURL: 'http://x/v1', keyEnv: 'MYLAB_KEY' } } });
  assert.equal(custom.providerInfo.baseURL, 'http://x/v1');
  assert.throws(() => resolveModel('nowhere:model'), /Unknown model provider/);
  assert.throws(() => resolveModel('gpt-5'), /provider/);
  assert.equal(modelKey('claude-haiku-5-5'), 'anthropic:claude-haiku-5-5');
}

// ---- Keys ----
{
  assert.equal(guessProvider('sk-ant-api03-abcdefghijklmnopqrstuv'), 'anthropic');
  assert.equal(guessProvider('sk-or-v1-abcdefghijklmnopqrstuvwxyz'), 'openrouter');
  assert.equal(guessProvider('sk-proj-abcdefghijklmnopqrstuvwxyz'), 'openai');
  assert.equal(guessProvider('gsk_abcdefghijklmnopqrstuvwxyz'), 'groq');
  assert.equal(guessProvider('hello'), null);
  assert.equal(checkKey('openrouter', 'sk-or-v1-abcdefghijklmnopqrstuvwxyz'), null);
  assert.match(checkKey('openrouter', 'sk-ant-api03-abcdefghijklmnopqrstuv'), /OpenRouter/);
  assert.match(checkKey('together', 'short'), /does not look/);
  assert.deepEqual(parseKeys('sk-ant-old'), { anthropic: 'sk-ant-old' }, 'a key saved before other providers is Anthropic');
  assert.deepEqual(parseKeys('{"openrouter":"k"}'), { openrouter: 'k' });
  const cfg = { plannerModel: 'claude-sonnet-5-5', workerModel: RIPPLE };
  assert.deepEqual(missingKeys(cfg, { anthropic: 'a' }), ['openrouter']);
  assert.deepEqual(missingKeys(cfg, { anthropic: 'a', openrouter: 'b' }), []);
  assert.deepEqual(missingKeys({ model: 'ollama:llama3.3' }, {}), [], 'a local model needs no key');
  assert.deepEqual(keysFromEnv({ OPENROUTER_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }), { anthropic: 'y', openrouter: 'x' });
}

// ---- Tools for a small context ----
{
  const tools = [{ name: 'desktop__click', description: 'x'.repeat(500) }, { name: 'desktop__set_agent_cursor_theme', description: 'y' }, { name: 'browser__browser_resize', description: 'z' }];
  assert.equal(fitTools(tools, resolveModel('claude-sonnet-5-5')), tools, 'Claude keeps every tool');
  assert.deepEqual(fitTools(tools, resolveModel('openrouter:x/small', { models: { 'openrouter:x/small': { context: 131072 } } })).map((t) => t.name), ['desktop__click']);
  const small = fitTools(tools, resolveModel('together:a/b'));
  assert.ok(small[0].description.length <= 240, 'descriptions are cut for a very small context');
}

// ---- Anthropic messages -> chat ----
{
  const shot = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const params = {
    model: RIPPLE, max_tokens: 1000,
    system: [{ type: 'text', text: 'You are "Alpha".', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'echo__shout', description: 'Shout', input_schema: { type: 'object', properties: { text: { type: 'string' } } } }],
    tool_choice: { type: 'none' },
    output_config: { effort: 'max' },
    betas: ['x'], context_management: { edits: [] }, cache_control: { type: 'ephemeral' },
    messages: [
      { role: 'user', content: 'Begin.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Shouting.' }, { type: 'tool_use', id: 'c1', name: 'echo__shout', input: { text: 'hi' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'HI' }, shot] }, { type: 'text', text: 'Message from the lead: go on' }] },
    ],
  };
  const blind = toChat(params, resolveModel(RIPPLE));
  assert.equal(blind.model, 'ricursiveai/ripple-65b-preview');
  assert.deepEqual(blind.messages[0], { role: 'system', content: 'You are "Alpha".' });
  assert.equal(blind.messages[2].tool_calls[0].function.name, 'echo__shout');
  assert.equal(blind.messages[2].tool_calls[0].function.arguments, '{"text":"hi"}');
  assert.deepEqual(blind.messages[3], { role: 'tool', tool_call_id: 'c1', content: 'HI' });
  assert.equal(blind.messages[4].role, 'user');
  assert.match(blind.messages[4].content, /go on[\s\S]*cannot see images/, 'no picture for a text-only model, a note instead');
  assert.equal(blind.tool_choice, 'none');
  assert.equal(blind.tools[0].function.parameters.properties.text.type, 'string');
  for (const k of ['betas', 'context_management', 'cache_control', 'output_config', 'system']) assert.ok(!(k in blind), `${k} is not sent`);
  assert.deepEqual(blind.reasoning, { effort: 'high', exclude: true }, 'Ripple takes OpenRouter\'s reasoning setting');
  const seeing = toChat(params, resolveModel('openai:gpt-5'));
  const pic = seeing.messages[4].content.find((p) => p.type === 'image_url');
  assert.equal(pic.image_url.url, 'data:image/png;base64,AAAA', 'a seeing model gets the screenshot after the tool message');
  assert.equal(seeing.reasoning_effort, 'high');
}

// ---- chat -> Anthropic messages ----
{
  const reply = fromChat({
    id: 'r1',
    choices: [{ finish_reason: 'tool_calls', message: { content: 'On it.', tool_calls: [{ id: 'k1', function: { name: 'echo__shout', arguments: '```json\n{"text":"a",}\n```' } }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } },
  }, RIPPLE);
  assert.equal(reply.stop_reason, 'tool_use');
  assert.deepEqual(reply.content, [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'k1', name: 'echo__shout', input: { text: 'a' } }], 'fenced JSON with a trailing comma is repaired');
  assert.deepEqual(reply.usage, { input_tokens: 40, output_tokens: 7, cache_read_input_tokens: 60, cache_creation_input_tokens: 0 });
  assert.equal(fromChat({ choices: [{ finish_reason: 'length', message: { content: 'cut' } }] }).stop_reason, 'max_tokens');
  assert.equal(fromChat({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] }).stop_reason, 'end_turn');
  assert.equal(parseArgs('not json').ok, false);
}

// ---- Fitting a long history into a small context ----
{
  const messages = [{ role: 'user', content: 'The task: shout.' }];
  for (let i = 0; i < 60; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `c${i}`, name: 'echo__shout', input: { text: `step ${i}` } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${i}`, content: [{ type: 'text', text: `page ${i} `.repeat(600) }] }] });
  }
  const budget = 8000;
  const { messages: fitted, trimmed } = fitMessages(messages, budget);
  assert.ok(estimateTokens(fitted) <= budget, 'it fits');
  assert.ok(trimmed > 0, 'old steps were dropped');
  assert.equal(messages.length, 121, 'the agent\'s own history is untouched');
  assert.match(JSON.stringify(fitted[0]), /The task: shout\.[\s\S]*earlier messages were removed/, 'the task stays, with a note');
  assert.equal(fitted.at(-1).content[0].tool_use_id, 'c59', 'the latest step stays');
  // The chat translation of a fitted history has a call for every tool message.
  const chat = toChat({ messages: fitted, max_tokens: 100 }, resolveModel(RIPPLE));
  const ids = new Set();
  for (const m of chat.messages) {
    for (const c of m.tool_calls ?? []) ids.add(c.id);
    if (m.role === 'tool') assert.ok(ids.has(m.tool_call_id), `tool result ${m.tool_call_id} has its call`);
  }
  for (let i = 1; i < fitted.length; i++) assert.notEqual(fitted[i].role, fitted[i - 1].role, 'roles still alternate');
}

// ---- Billing per model ----
{
  const p = pricing({});
  const claudeOnly = costMicro({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, p);
  assert.equal(claudeOnly, Math.ceil(2 * 1.3 * 1e6), 'without a per-model split, the default rates');
  const split = costMicro({ byModel: { 'claude-sonnet-5-5': { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, [RIPPLE]: { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 } } }, p);
  assert.ok(Math.abs(split - (2 + 0.1 + 0.3) * 1.3 * 1e6) <= 1, 'Claude at the hosted rates, Ripple at its own');
  assert.equal(costMicro({ input: 5, byModel: {} }, p), 0, 'nothing on a hosted key costs nothing');
}

// ---- The client: routing, headers, a retry for broken tool arguments ----
const fake = (handler) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const out = await handler(body, calls.length);
    return { ok: out.status ? out.status < 400 : true, status: out.status ?? 200, headers: { get: () => null }, text: async () => JSON.stringify(out.body ?? out) };
  };
  return { calls, fetchImpl };
};
const chatReply = (message, finish = 'stop') => ({ id: 'x', choices: [{ finish_reason: finish, message }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
{
  const { calls, fetchImpl } = fake((body, n) => (n === 1
    ? chatReply({ content: '', tool_calls: [{ id: 'a', function: { name: 'echo__shout', arguments: '{"text": ' } }] }, 'tool_calls')
    : chatReply({ content: '', tool_calls: [{ id: 'b', function: { name: 'echo__shout', arguments: '{"text":"ok"}' } }] }, 'tool_calls')));
  const llm = makeLlm({ openrouter: 'sk-or-v1-test' }, {}, { fetchImpl });
  const res = await llm.create({ model: RIPPLE, max_tokens: 100000, messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'echo__shout', input_schema: { type: 'object' } }] });
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer sk-or-v1-test');
  assert.equal(calls[0].headers['X-Title'], 'Senju');
  assert.equal(calls[0].body.max_tokens, 32768, 'the reply is capped at the model\'s own maximum');
  assert.equal(calls.length, 2, 'arguments that were not JSON: asked once more');
  assert.deepEqual(res.content[0].input, { text: 'ok' });
  assert.equal(res.usage.input_tokens, 40, 'both calls are counted');
  assert.equal(llm.profile(RIPPLE).vision, false);
  assert.throws(() => makeLlm({}, {}, { fetchImpl }).create({ model: RIPPLE, messages: [] }), /No OpenRouter API key/);
  // A failing gateway: retried, then the error carries its status so the orchestrator can read it.
  const failing = fake(() => ({ status: 400, body: { error: { message: 'This model\'s maximum context length is 131072 tokens' } } }));
  await assert.rejects(makeLlm({ openrouter: 'k' }, {}, { fetchImpl: failing.fetchImpl }).create({ model: RIPPLE, messages: [{ role: 'user', content: 'x' }] }), (err) => err.status === 400 && /maximum context/.test(err.message));
}

// ---- A whole job on Ripple (lead and worker), through the chat API ----
{
  const echo = { command: process.execPath, args: [path.join(here, 'echo-server.mjs')], app: 'Finder' };
  const seen = { lead: 0, worker: 0, bodies: [] };
  const { fetchImpl } = fake((body) => {
    seen.bodies.push(body);
    const isLead = body.tools?.some((t) => t.function.name === 'spawn_agent');
    const last = body.messages.at(-1);
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    if (isLead) {
      seen.lead++;
      if (seen.lead === 1) return chatReply({ content: 'Starting a worker.', tool_calls: [{ id: 'L1', function: { name: 'spawn_agent', arguments: JSON.stringify({ name: 'Alpha', goal: 'shout hello', servers: ['echo'] }) } }] }, 'tool_calls');
      if (/No workers are running|finished/.test(text) && seen.worker >= 2) return chatReply({ content: 'Alpha shouted HELLO.' });
      return chatReply({ content: '', tool_calls: [{ id: `W${seen.lead}`, function: { name: 'wait', arguments: '{}' } }] }, 'tool_calls');
    }
    seen.worker++;
    if (seen.worker === 1) return chatReply({ content: 'Shouting.', tool_calls: [{ id: 'S1', function: { name: 'echo__shout', arguments: '{"text":"hello"}' } }] }, 'tool_calls');
    assert.match(JSON.stringify(body.messages), /"role":"tool","tool_call_id":"S1","content":"HELLO"/, 'the tool result reaches the model as a tool message');
    return chatReply({ content: 'I shouted it: HELLO.' });
  });
  const config = { model: RIPPLE, maxAgents: 2, maxSteps: 6, servers: { echo } };
  const events = [];
  const swarm = new Swarm({ llm: makeLlm({ openrouter: 'sk-or-v1-test' }, config, { fetchImpl }), config, workspace: '/tmp', emit: (e) => events.push(e) });
  await swarm.run('shout hello');
  assert.equal(events.find((e) => e.type === 'done')?.summary, 'Alpha shouted HELLO.');
  assert.ok(!events.some((e) => e.type === 'error'), JSON.stringify(events.filter((e) => e.type === 'error')));
  for (const b of seen.bodies) {
    for (const k of ['betas', 'context_management', 'output_config']) assert.ok(!(k in b), `no ${k} for a non-Anthropic model`);
  }
  const workerBody = seen.bodies.find((b) => !b.tools?.some((t) => t.function.name === 'spawn_agent'));
  assert.match(workerBody.messages[0].content, /You cannot see images/, 'a text-only worker is told so');
  assert.ok(!workerBody.tools.some((t) => /look_at_page|click_at/.test(t.function.name)), 'and gets no picture tools');
  assert.ok(swarm.usage.byModel[RIPPLE].input > 0, 'tokens are counted per model');
  await swarm.shutdown();
}

console.log('models test passed');
