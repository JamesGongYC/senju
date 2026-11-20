// Quick replies: a worker in the middle of a long tool call answers the user right away, in plain words,
// while the call keeps running; on its next step it sees the message as already answered.
import assert from 'node:assert/strict';
import { Swarm } from '../src/orchestrator.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let uid = 0;
const use = (name, input = {}) => ({ type: 'tool_use', id: `t${++uid}`, name, input });
const say = (text) => ({ type: 'text', text });
const textOf = (m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.type === 'text' ? b.text : (b.content ?? []).map((c) => c.text ?? '').join('')).join('\n'));

const seen = { quick: null, after: '' };
let workerTurn = 0, toolDone = 0;
const llm = {
  async create(params) {
    await sleep(10);
    const isLead = params.tools?.[0]?.name === 'spawn_agent';
    const r = (content) => ({ content: Array.isArray(content) ? content : [content], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
    if (isLead) {
      const last = textOf(params.messages.at(-1));
      if (params.messages.length === 1) return r(use('spawn_agent', { name: 'Builder', goal: 'Build the site. Then report.', servers: ['slow'] }));
      if (/finished/.test(last)) return r(say('Done.'));
      return r(use('wait'));
    }
    if (params.tool_choice?.type === 'none') {
      seen.quick = { params, at: Date.now() };
      return r(say("I'm waiting on Claude Code to finish writing the site files; it's been running about a second. Next I'll check them and report."));
    }
    workerTurn++;
    if (workerTurn === 1) return r([say('Building with Claude Code.'), use('slow__build', {})]);
    seen.after = textOf(params.messages.at(-1));
    return r(say('Built the site.'));
  },
};
const connect = async (name) => ({
  name, spec: {}, pid: null, close: async () => {},
  tools: [{ name: 'build', description: 'slow build', inputSchema: { type: 'object', properties: {} } }],
  client: { callTool: async () => { await sleep(1500); toolDone = Date.now(); return { content: [{ type: 'text', text: 'built' }] }; } },
});

const events = [];
const swarm = new Swarm({ llm, config: { model: 'fake', maxAgents: 2, maxSteps: 5, skills: false, servers: { slow: { app: 'Finder' } } }, workspace: '/tmp', emit: (e) => events.push(e), connect });
const run = swarm.run('build it');
while (!swarm.agents[0]?.busy) await sleep(10);
await sleep(200);
assert.equal(swarm.tell('what are you doing?', swarm.agents[0].id), true);
await run;

const chat = events.find((e) => e.type === 'chat' && e.name === 'Builder');
assert.ok(chat, 'the worker answered in the chat');
assert.match(chat.text, /^I'm waiting on Claude Code/, 'in plain words');
assert.ok(seen.quick.at < toolDone, 'before the long tool call came back');
const q = seen.quick.params;
const last = q.messages.at(-1);
assert.ok(last.content.some((b) => b.type === 'tool_result' && /Still running/.test(b.content[0].text)), 'it knows its step is still running');
assert.match(textOf(last), /Message from the user: what are you doing\?/);
assert.equal(events.filter((e) => e.type === 'chat' && e.name === 'Builder').length, 1, 'answered once, not again on the next step');
assert.match(seen.after, /already answered this while your last step was running/);
console.log('quick reply test passed');
process.exit(0);
