// The agents' terminal: commands run, their output and exit codes come back as text,
// long ones keep running and can be read, answered and stopped.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-term-test-'));
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-term-bin-'));
// A stand-in for the claude CLI: it notes its arguments, writes a file and streams JSON events, as
// claude --output-format stream-json --include-partial-messages does.
const events = [
  { type: 'system', subtype: 'init', model: 'fake-model' },
  { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Building the ' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'site now.' } } },
  { type: 'stream_event', event: { type: 'content_block_stop' } },
  // A command with a newline in it, split across deltas.
  { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'b1', name: 'Bash' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'python3 -c "\nimport json"' }).slice(0, -1) } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '}' } } },
  { type: 'stream_event', event: { type: 'content_block_stop' } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'line one\nline two' }] } },
  // A file written in pieces, with escapes cut in half between deltas.
  ...(() => {
    const json = JSON.stringify({ file_path: 'index.html', content: '<h1>Hi</h1>\n<p class="x">café</p>' }).replace('é', '\\u00e9');
    const cuts = [json.indexOf('\\n') + 1, json.indexOf('\\u00e9') + 4];
    return [
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'w1', name: 'Write' } } },
      ...[json.slice(0, cuts[0]), json.slice(cuts[0], cuts[1]), json.slice(cuts[1])].map((partial_json) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json } } })),
      { type: 'stream_event', event: { type: 'content_block_stop' } },
    ];
  })(),
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Building the site now.' }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w1', is_error: true, content: 'lint failed' }] } },
  { type: 'result', subtype: 'success', is_error: false, duration_ms: 65000, num_turns: 3, total_cost_usd: 0.12, result: 'Built index.html.' },
];
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
fs.writeFileSync('index.html', 'built');
for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));
`);
fs.chmodSync(path.join(bin, 'claude'), 0o755);

const client = new Client({ name: 'test', version: '1' });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [path.join(here, '../src/terminal-server.js'), ws],
  env: { ...process.env, SENJU_TERMINAL: 'hidden', SENJU_CLAUDE: path.join(bin, 'claude') },
}));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }); return { text: r.content.map((c) => c.text).join('\n'), isError: Boolean(r.isError) }; };
const idOf = (t) => t.match(/command id (\d+)/)[1];

const names = (await client.listTools()).tools.map((t) => t.name);
assert.deepEqual(names, ['run_command', 'claude_code', 'read_output', 'send_input', 'stop_command']);

let r = await call('run_command', { command: 'echo hello; pwd; echo oops >&2' });
assert.match(r.text, /Exited with code 0/);
assert.match(r.text, /hello/);
assert.match(r.text, new RegExp(path.basename(ws)));
assert.match(r.text, /oops/, 'stderr comes back too');

r = await call('run_command', { command: 'exit 3' });
assert.match(r.text, /Exited with code 3/);

r = await call('run_command', { command: 'echo "it\'s \\"quoted\\" $((1+2))"' });
assert.match(r.text, /it's "quoted" 3/);

r = await call('run_command', { command: 'echo x', cwd: '/no/such/folder' });
assert.equal(r.isError, true);

// A long command keeps running; read it, answer it, stop it.
r = await call('run_command', { command: 'echo started; read answer; echo "got $answer"; sleep 30', timeout_seconds: 1 });
assert.match(r.text, /Still running/);
assert.match(r.text, /started/);
const id = idOf(r.text);
const sent = await call('send_input', { id, text: 'yes' });
r = await call('read_output', { id, wait_seconds: 1 });
assert.match(sent.text + r.text, /got yes/);
r = { text: sent.text + r.text };
assert.doesNotMatch(r.text, /started/, 'only new output');
r = await call('stop_command', { id });
assert.match(r.text, /Exited with code/);

// Claude Code: the prompt arrives intact, edits are accepted, commands only when allowed.
r = await call('claude_code', { prompt: 'Build "the site" & test it', cwd: 'site' });
const argsOf = () => JSON.parse(fs.readFileSync(path.join(ws, 'site', 'args.json'), 'utf8'));
let args = argsOf();
assert.deepEqual(args.slice(0, 6), ['-p', 'Build "the site" & test it', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
assert.equal(args[args.indexOf('--add-dir') + 1], ws, 'it may read the whole workspace');
assert.ok(args.includes('acceptEdits'));
assert.ok(!args.includes('--allowedTools'));
// The agent reads a short account: what Claude Code said and did, failures, the summary and its answer, once
// each, without the code it typed or what its commands printed.
assert.match(r.text, /Claude Code started \(fake-model\)/);
assert.equal(r.text.match(/Building the site now\./g)?.length, 1);
assert.match(r.text, /→ Bash python3 -c " import json"/, 'escapes decoded in the command shown');
assert.match(r.text, /→ Write index\.html\n {3}\(2 lines, 33 characters\)/);
assert.doesNotMatch(r.text, /<h1>Hi/, 'no code for the agent');
assert.doesNotMatch(r.text, /line two/, 'no command output for the agent');
assert.match(r.text, /✗ lint failed/);
assert.match(r.text, /Done in 1m 5s · 3 turns · \$0\.12/);
assert.match(r.text, /Final answer:\nBuilt index\.html\./);
assert.match(r.text, /Exited with code 0/);
assert.doesNotMatch(r.text, /"type":/, 'no raw JSON');
assert.ok(fs.existsSync(path.join(ws, 'site', 'index.html')));
r = await call('claude_code', { prompt: 'again', cwd: 'site', allow_commands: true, continue_session: true });
args = argsOf();
assert.ok(args.includes('--allowedTools') && args.includes('Bash') && args.includes('--continue'));

// The window shows the code as it is typed, decoded, and the last lines a command printed.
{
  const { execFileSync } = await import('node:child_process');
  const pf = path.join(ws, 'p.txt');
  fs.writeFileSync(pf, 'x');
  const shown = execFileSync(process.execPath, [path.join(here, '../src/claude-stream.js'), pf, '--claude', path.join(bin, 'claude')], { cwd: ws, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.match(shown, /│ <h1>Hi<\/h1>\n {2}│ <p class="x">café<\/p>/, 'the file as it is written');
  assert.match(shown, /│ line two/, 'what the command printed');
  assert.match(shown, /└ 2 lines/);
}

await client.close();
console.log('terminal test passed');
