// Sampling temperature: workers on OpenAI-compatible models default to 0.2 (tool calls, and what a speculative
// decoding drafter guesses best), the lead and Claude keep the endpoint default, config overrides it, and an
// endpoint that refuses a temperature is left at its default from then on.
import assert from 'node:assert/strict';
import { resolveModel } from '../src/models.js';
import { toChat, openAiCreate } from '../src/llm-openai.js';
import { makeLlm } from '../src/llm.js';
import { Swarm } from '../src/orchestrator.js';

const RIPPLE = 'openrouter:ricursiveai/ripple-65b-preview';
const CLAUDE = 'claude-sonnet-5-5';
const swarmWith = (config) => new Swarm({ llm: makeLlm({ openrouter: 'sk-or-v1-test', anthropic: 'sk-ant-test' }, config), config: { maxAgents: 1, servers: {}, ...config }, workspace: '/tmp', emit: () => {} });

// ---- Per role and per model ----
{
  const s = swarmWith({ model: RIPPLE });
  assert.equal(s.effortParams('worker', RIPPLE).temperature, 0.2, 'workers on Ripple default to 0.2');
  assert.ok(!('temperature' in s.effortParams('lead', RIPPLE)), 'the lead keeps the endpoint default');
  const c = swarmWith({ model: CLAUDE });
  assert.ok(!('temperature' in c.effortParams('worker', CLAUDE)), 'Claude keeps its default unless configured');
  assert.equal(swarmWith({ model: CLAUDE, temperature: 0.5 }).effortParams('lead', CLAUDE).temperature, 0.5, 'a number applies to every role and model');
  const both = swarmWith({ model: RIPPLE, temperature: { lead: 0.7, worker: 0 } });
  assert.equal(both.effortParams('lead', RIPPLE).temperature, 0.7);
  assert.equal(both.effortParams('worker', RIPPLE).temperature, 0, 'zero is sent, not dropped');
  assert.ok(!('temperature' in swarmWith({ model: RIPPLE, temperature: null }).effortParams('worker', RIPPLE)), 'null sends none');
  // A model with no effort setting still gets its temperature.
  const plain = 'ollama:llama3.3';
  assert.equal(swarmWith({ model: plain, effort: 'high' }).effortParams('worker', plain).temperature, 0.2);
  assert.ok(!('output_config' in swarmWith({ model: plain, effort: 'high' }).effortParams('worker', plain)));
}

// ---- The chat request carries it ----
{
  const params = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 };
  assert.equal(toChat({ ...params, temperature: 0.2 }, resolveModel(RIPPLE)).temperature, 0.2);
  assert.equal(toChat({ ...params, temperature: 0 }, resolveModel(RIPPLE)).temperature, 0);
  assert.ok(!('temperature' in toChat(params, resolveModel(RIPPLE))));
}

// ---- A temperature refusal is learned once ----
{
  const sent = [];
  let refused = false;
  const client = {
    async post(req) {
      sent.push({ ...req });
      if ('temperature' in req && !refused) {
        refused = true;
        throw Object.assign(new Error("400 Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported."), { status: 400 });
      }
      return { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] };
    },
  };
  const create = openAiCreate(client, resolveModel('openai:o3'));
  const params = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, temperature: 0.2 };
  assert.equal((await create(params)).content[0].text, 'ok');
  await create(params);
  assert.equal(sent.length, 3);
  assert.equal(sent[0].temperature, 0.2);
  assert.ok(!('temperature' in sent[1]) && !('temperature' in sent[2]), 'dropped on the retry and remembered after');
  // Any other 400 still fails.
  const bad = openAiCreate({ async post() { throw Object.assign(new Error('400 invalid tools'), { status: 400 }); } }, resolveModel(RIPPLE));
  await assert.rejects(bad(params), /invalid tools/);
}

console.log('sampling test passed');
