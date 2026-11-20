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
// A stand-in for the claude CLI that prints what it was asked.
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "claude args: $*"\necho built > index.html\n');
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
assert.match(r.text, /claude args: -p Build "the site" & test it --permission-mode acceptEdits/);
assert.doesNotMatch(r.text, /allowedTools/);
assert.ok(fs.existsSync(path.join(ws, 'site', 'index.html')));
r = await call('claude_code', { prompt: 'again', cwd: 'site', allow_commands: true, continue_session: true });
assert.match(r.text, /--allowedTools Bash --continue/);

await client.close();
console.log('terminal test passed');
