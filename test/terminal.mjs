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
if (process.argv.includes('think')) {
  const say = (e) => console.log(JSON.stringify(e));
  say({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } });
  setTimeout(() => {
    say({ type: 'stream_event', event: { type: 'content_block_stop' } });
    say({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
    say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Thought it through.' } } });
    say({ type: 'stream_event', event: { type: 'content_block_stop' } });
    say({ type: 'result', is_error: false, duration_ms: 4000, num_turns: 1, result: 'Thought it through.' });
  }, 4200);
  return;
}
if (process.argv.includes('slow')) { fs.writeFileSync('claude.pid', String(process.pid)); console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-model' })); setInterval(() => {}, 1000); return; }
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

// A long think shows as a live "thinking" line in the window (never in the agent's summary), which goes away
// when Claude starts writing.
{
  const { execFileSync } = await import('node:child_process');
  const pf = path.join(ws, 'think.txt');
  const sf = path.join(ws, 'think-summary.log');
  fs.writeFileSync(pf, 'think');
  const shown = execFileSync(process.execPath, [path.join(here, '../src/claude-stream.js'), pf, '--claude', path.join(bin, 'claude'), '--summary', sf], { cwd: ws, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, SENJU_COLOR: '1' } });
  assert.match(shown, /Claude is thinking… 3s/);
  assert.match(shown, /\r\x1b\[2K[^\r]*Thought it through\./, 'the line is cleared before Claude writes');
  assert.doesNotMatch(fs.readFileSync(sf, 'utf8'), /thinking…/);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const pidIn = async (dir) => { const f = path.join(dir, 'claude.pid'); for (let i = 0; i < 100 && !fs.existsSync(f); i++) await sleep(50); return Number(fs.readFileSync(f, 'utf8')); };

// Stopping the wrapper stops claude, its child (a window's command is stopped by signalling the wrapper only).
{
  const { spawn } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(ws, 'stop-'));
  fs.writeFileSync(path.join(dir, 'p.txt'), 'slow');
  const wrapper = spawn(process.execPath, [path.join(here, '../src/claude-stream.js'), path.join(dir, 'p.txt'), '--claude', path.join(bin, 'claude')], { cwd: dir, stdio: 'ignore' });
  const pid = await pidIn(dir);
  assert.ok(alive(pid));
  wrapper.kill('SIGTERM');
  await new Promise((res) => wrapper.on('exit', res));
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
  assert.ok(!alive(pid), 'claude stopped with its wrapper');
}

// A claude_code call that is cancelled (the job was stopped) stops Claude Code instead of leaving it running.
{
  const ctl = new AbortController();
  const pending = client.callTool({ name: 'claude_code', arguments: { prompt: 'slow', cwd: 'slow' } }, undefined, { signal: ctl.signal, timeout: 60_000 }).catch(() => 'cancelled');
  const pid = await pidIn(path.join(ws, 'slow'));
  assert.ok(alive(pid));
  ctl.abort();
  assert.equal(await pending, 'cancelled');
  for (let i = 0; i < 60 && alive(pid); i++) await sleep(50);
  assert.ok(!alive(pid), 'Claude Code stopped when its call was cancelled');
}

await client.close();

// Claude Code in its own window: what is typed into its prompt box, and the agent's account from its transcript.
{
  const { promptKeys, typedChars, account, writeHooks } = await import('../src/claude-window.js');
  const short = promptKeys('Build the site\tnow\x07\r\nthen test it');
  assert.equal(short.length, 1);
  assert.equal(short[0][1], 'Build the site  now\nthen test it ', 'tabs and control keys go, line breaks stay');
  assert.ok(short[0][0] >= 3 && short[0][0] <= 28);
  assert.equal(promptKeys('/clear everything')[0][1].slice(0, 2), ' /', 'a leading slash is not a command');
  const long = promptKeys('x'.repeat(5000));
  assert.equal(typedChars(long), 300, 'a long task is typed in part and the rest pasted');
  assert.ok(long[1][1].startsWith('\x1b[200~') && long[1][1].endsWith('\x1b[201~'));
  const lines = account([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Writing it.' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/p/site/index.html', content: '<h1>' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'disk full' }] } },
  ], '/p/site');
  assert.deepEqual(lines, ['Writing it.', '→ Write index.html', '   ✗ Write: disk full'], 'paths are shown inside the project, no code');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-hooks-'));
  const hooks = JSON.parse(fs.readFileSync(writeHooks(dir), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('terminal test passed');
