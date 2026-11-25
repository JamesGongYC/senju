// Inference fixes for Ripple and other OpenAI-compatible endpoints: OpenRouter routing away from Together,
// transient empty replies retried, inline reasoning cut out, and a lead whose context fills up shrinks its
// history once instead of looping.
import assert from 'node:assert/strict';
import { resolveModel } from '../src/models.js';
import { toChat, fromChat, makeOpenAiClient } from '../src/llm-openai.js';
import { Swarm } from '../src/orchestrator.js';

const RIPPLE = 'openrouter:ricursiveai/ripple-65b-preview';
const params = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 };

// ---- OpenRouter: never routed to Together (131K context, no tools) ----
{
  assert.deepEqual(toChat(params, resolveModel(RIPPLE)).provider, { ignore: ['together'] });
  const own = resolveModel('ripple-gpu:ricursiveai/ripple-65b-preview', { providers: { 'ripple-gpu': { baseURL: 'http://x/v1', keyEnv: 'RIPPLE_GPU_API_KEY' } } });
  assert.equal(own.context, 1048576, 'a self-hosted Ripple still gets the Ripple profile');
  assert.ok(!('provider' in toChat(params, own)), 'no OpenRouter routing sent to another server');
  assert.ok(!('provider' in toChat(params, resolveModel('together:ricursiveai/ripple-65b-preview'))));
}

// ---- Inline reasoning is not part of the reply ----
{
  const r = fromChat({ choices: [{ finish_reason: 'stop', message: { content: '<think>17*23 is 391</think>391' } }] });
  assert.deepEqual(r.content, [{ type: 'text', text: '391' }]);
  const open = fromChat({ choices: [{ finish_reason: 'stop', message: { content: 'let me see...</think>Done.' } }] });
  assert.deepEqual(open.content, [{ type: 'text', text: 'Done.' }], 'a reply that starts mid-thought (opening tag in the prompt) too');
}

// ---- A 200 with no choices, and a 408, are retried ----
{
  const replies = [
    { status: 200, body: { id: 'x', choices: [] } },
    { status: 408, body: { error: { message: 'timeout' } } },
    { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] } },
  ];
  let calls = 0;
  const fetchImpl = async () => {
    const r = replies[calls++];
    return { ok: r.status < 400, status: r.status, headers: { get: () => '0.01' }, text: async () => JSON.stringify(r.body) };
  };
  const data = await makeOpenAiClient({ baseURL: 'http://x/v1', apiKey: 'k', fetchImpl }).post({}, undefined);
  assert.equal(calls, 3);
  assert.equal(data.choices[0].message.content, 'ok');
}

// ---- The lead's context window fills up ----
const config = { model: 'fake', maxAgents: 2, maxSteps: 6, skills: false, servers: {} };
const FULL = { content: [], stop_reason: 'model_context_window_exceeded', usage: { input_tokens: 0, output_tokens: 0 } };
const say = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
const tooLong = () => Object.assign(new Error("400 This endpoint's maximum context length is 1048576 tokens"), { status: 400 });

// Shrinks once and carries on.
for (const first of [() => FULL, () => { throw tooLong(); }]) {
  let calls = 0;
  const llm = { async create() { calls++; return calls === 1 ? first() : say('all good'); } };
  const events = [];
  const swarm = new Swarm({ llm, config, workspace: '/tmp', emit: (e) => events.push(e) });
  await swarm.run('anything');
  await swarm.shutdown();
  assert.equal(calls, 2);
  assert.equal(events.find((e) => e.type === 'done')?.summary, 'all good');
}

// A window that stays full ends the job after one shrink, instead of "be briefer" up to MAX_LEAD_TURNS times.
{
  let calls = 0;
  const llm = { async create() { calls++; return FULL; } };
  const swarm = new Swarm({ llm, config, workspace: '/tmp', emit: () => {} });
  await swarm.run('anything').catch(() => {});
  await swarm.shutdown();
  assert.equal(calls, 2, `lead made ${calls} calls on a full context window`);
}

console.log('ripple inference test passed');
