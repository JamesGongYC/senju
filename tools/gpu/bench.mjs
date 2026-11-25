// How fast is a Ripple endpoint for Senju's kind of call? Times a realistic worker turn (system prompt, a page
// snapshot, one tool; the model answers with one tool call), one at a time and then 4 at once like 4 workers.
//   OPENROUTER_API_KEY=sk-or-... node tools/gpu/bench.mjs                                  # OpenRouter
//   RIPPLE_GPU_URL=https://<...>.modal.run/v1 RIPPLE_GPU_API_KEY=... node tools/gpu/bench.mjs   # our own GPU
// A cold Modal endpoint takes minutes to start: the first call is reported separately and not counted.
import { makeLlm } from '../../src/llm.js';
import { keysFromEnv } from '../../src/models.js';

const own = process.env.RIPPLE_GPU_URL;
const model = own ? 'ripple-gpu:ricursiveai/ripple-65b-preview' : 'openrouter:ricursiveai/ripple-65b-preview';
const config = own ? { providers: { 'ripple-gpu': { baseURL: own, keyEnv: 'RIPPLE_GPU_API_KEY' } }, models: { [model]: { context: 131072 } } } : {};
const llm = makeLlm(keysFromEnv(process.env, config), config);
const N = Number(process.env.BENCH_N ?? 6);

const snapshot = Array.from({ length: 60 }, (_, i) => `e${i + 1} ${['button', 'link', 'textbox', 'text'][i % 4]} "${['Search', 'Sign in', 'Your answer', 'Results for oak trees', 'Next page'][i % 5]} ${i}"`).join('\n');
const params = () => ({
  model,
  max_tokens: 1024,
  system: [{ type: 'text', text: 'You are "Alpha", a worker in a swarm. You act on a web page only through the browser__sh tool, which runs commands (look, click <id>, type <id> "text" [--submit], wait 2s). Answer with one tool call.\n'.repeat(6) }],
  tools: [{ name: 'browser__sh', description: 'Run commands, one per line.', input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }],
  messages: [
    { role: 'user', content: 'Type one kind of tree into "Your answer" and submit it.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'browser__sh', input: { cmd: 'look' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: `ok\npage: Trees\n-- elements\n${snapshot}\n-- text\nName a type of tree\nUsed: Oak, Maple, Birch` }] }] },
  ],
});

async function once() {
  const t = Date.now();
  const res = await llm.create(params(), {});
  const call = res.content.find((b) => b.type === 'tool_use');
  return { ms: Date.now() - t, inTok: res.usage?.input_tokens ?? 0, outTok: res.usage?.output_tokens ?? 0, cmd: call?.input?.cmd ?? '(no tool call)' };
}
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

console.log(`model: ${model}${own ? `  endpoint: ${own.replace(/\/\/([^/]+).*/, '//$1')}` : ''}`);
const warm = await once();
console.log(`first call (includes any cold start): ${warm.ms} ms, ${warm.inTok} tokens in, ${warm.outTok} out -> ${warm.cmd.slice(0, 60)}`);
const seq = [];
for (let i = 0; i < N; i++) seq.push(await once());
console.log(`one at a time x${N}: median ${median(seq.map((r) => r.ms))} ms, min ${Math.min(...seq.map((r) => r.ms))}, max ${Math.max(...seq.map((r) => r.ms))}`);
const t = Date.now();
const par = await Promise.all(Array.from({ length: 4 }, once));
console.log(`4 at once: median ${median(par.map((r) => r.ms))} ms each, ${Date.now() - t} ms for all four`);
console.log(`sample answer: ${par[0].cmd.slice(0, 80)}`);
