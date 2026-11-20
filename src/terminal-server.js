// A terminal for the agents: an MCP server (stdio) that runs shell commands where the user can watch,
// and hands back what they printed and how they ended.
//
// Agents used to "use the terminal" by typing into Terminal with the desktop tools. That broke easily:
// keys landed in the wrong window, Return went missing, and the output could only be read back from
// screenshots. Here each command runs in a Terminal window of its own (never one the user already had
// open), its output is copied to a log as it runs, and the exit code is written down when it ends,
// so the agent reads exact text.
//
// Run with: node src/terminal-server.js <workspace>   (the app starts it as a "bundled" server)
// SENJU_TERMINAL=hidden runs commands without opening Terminal windows (tests, or no Terminal access).
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ClaudeWindow, writeFeeder } from './claude-window.js';

const WORKSPACE = path.resolve(process.argv[2] || path.join(os.homedir(), 'Senju'));
const HIDDEN = process.env.SENJU_TERMINAL === 'hidden' || process.platform !== 'darwin';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-term-'));
const OUTPUT_LIMIT = 12_000;   // characters of output handed back per call; the full log stays on disk

const FEEDER = HIDDEN ? null : writeFeeder(ROOT);
const runs = new Map();   // id -> { id, dir, command, cwd, windowId, child, started, readFrom }
let seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;   // shell single-quote
const asString = (s) => `"${String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;   // AppleScript string
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\r(?!\n)/g, '');
// macOS Terminal's own lines when a shell ends, which are not the command's output.
const SESSION_NOISE = /^(Saving session\.\.\.|\.\.\.copying shared history\.\.\.|\.\.\.saving history\.\.\.(truncating history files\.\.\.)?|\.\.\.completed\.|Deleting expired sessions\.\.\..*)$\n?/gm;

function osascript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 15_000 }, (err, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout.trim()));
  });
}

// Where a command runs: an absolute folder, or one relative to the workspace.
function folder(cwd) {
  const dir = cwd ? path.resolve(WORKSPACE, String(cwd).replace(/^~(?=$|\/)/, os.homedir())) : WORKSPACE;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`No such folder: ${dir}`);
  return dir;
}

// Start a command. In a Terminal window it runs in the user's own shell (their PATH, their tools);
// hidden, it runs in a login zsh.
// display: what the window's header shows instead of the raw command (Claude Code's long wrapper line).
// kind: 'claude' or 'command'. A new window closes the finished windows of its own kind (see closeFinished).
async function start(command, cwd, title, display = command, kind = 'command') {
  const id = String(++seq);
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'cmd.sh'), `${command}\n`);
  fs.writeFileSync(path.join(dir, 'out.log'), '');
  const run = { id, dir, command, cwd, title, windowId: null, child: null, started: Date.now(), readFrom: 0, logFile: null, kind };
  runs.set(id, run);
  const log = path.join(dir, 'out.log'), exit = path.join(dir, 'exit'), pid = path.join(dir, 'pid');

  let shown = false;
  if (!HIDDEN) {
    // The line typed into the new window. It starts with a space so it stays out of the shell history.
    // The subshell writes its pid (to stop it later), runs the command with its output copied to the log,
    // and the exit code is written down afterwards: PIPESTATUS for bash, pipestatus for zsh.
    fs.writeFileSync(path.join(dir, 'banner'), `\x1b[2m── ${title ?? 'Senju'} · ${cwd}\x1b[0m\n\x1b[1m$ ${display}\x1b[0m\n`);
    closeFinished(kind);
    const line = ` clear; cat ${q(path.join(dir, 'banner'))}; ( sh -c 'echo $PPID' > ${q(pid)}; cd ${q(cwd)} && source ${q(path.join(dir, 'cmd.sh'))} ) 2>&1 | tee ${q(log)}; echo "\${PIPESTATUS[0]}\${pipestatus[1]}" > ${q(exit)}`;
    try {
      const wid = await osascript(`tell application "Terminal"
  set t to do script ${asString(line)}
  delay 0.2
  set w to first window whose tabs contains t
  set custom title of t to ${asString(title ?? 'Senju')}
  return id of w
end tell`);
      run.windowId = Number(wid) || null;
      shown = true;
    } catch (err) {
      run.note = `Could not open a Terminal window (${err.message}), so it ran without one.`;
    }
  }
  if (!shown) {
    const child = spawn('/bin/zsh', ['-lc', `cd ${q(cwd)} && source ${q(path.join(dir, 'cmd.sh'))}`], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    run.child = child;
    fs.writeFileSync(pid, String(child.pid));
    const out = fs.createWriteStream(log, { flags: 'a' });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on('close', (code, signal) => { out.end(() => fs.writeFileSync(exit, String(code ?? (signal ? 128 + 15 : 1)))); });
  }
  return run;
}

// Finished windows close when the next one of their kind opens, so they do not pile up on top of each other:
// a finished command's when the next command starts, a finished Claude Code window (worth looking back at) only
// when Claude Code is started again. Output stays in the log. A window still running, or that ended under a
// second ago, stays open.
function closeFinished(kind) {
  for (const run of runs.values()) {
    if (run.kind !== kind || !run.windowId || run.closed || status(run) === null) continue;
    try { if (Date.now() - fs.statSync(path.join(run.dir, 'exit')).mtimeMs < 1000) continue; } catch { continue; }
    run.closed = true;
    osascript(`tell application "Terminal" to close (every window whose id is ${run.windowId})`).catch(() => {});
  }
}

function status(run) {
  if (run.cc) {
    // A Claude Code window: its task is over when it finishes (or is interrupted), or Claude Code quits.
    run.cc.poll();
    const code = run.cc.exitCode();
    if (code !== null) return code;
    if (run.cc.turn?.stopped) return 130;
    return run.cc.turn?.done ? 0 : null;
  }
  const file = path.join(run.dir, 'exit');
  if (!fs.existsSync(file)) return null;
  const code = Number(fs.readFileSync(file, 'utf8').trim());
  return Number.isFinite(code) ? code : 1;
}

// Wait until the command ends or the time is up. If the call is cancelled while it waits (the user stopped the
// job, or the worker was stopped), the command is stopped too: otherwise it would carry on in its window with
// no one waiting for it (a Claude Code run kept building, and spending, after its job was stopped).
async function wait(run, seconds, signal) {
  const until = Date.now() + Math.max(0, seconds) * 1000;
  // A Claude Code window asking for permission is waiting on someone: hand it to the agent now.
  while (status(run) === null && Date.now() < until && !signal?.aborted && !run.cc?.turn?.notice) await sleep(250);
  if (signal?.aborted && status(run) === null) { kill(run); return null; }
  if (status(run) !== null) await sleep(100);   // let the last of the output reach the log
  return status(run);
}

// What the command printed since the agent last read, cut to the last OUTPUT_LIMIT characters.
// A run can keep a shorter account for the agent than what its window shows (Claude Code: no code, no command
// output); then that is what the agent reads.
function newOutput(run) {
  const file = run.logFile && fs.existsSync(run.logFile) ? run.logFile : path.join(run.dir, 'out.log');
  const all = stripAnsi(fs.readFileSync(file, 'utf8')).replace(SESSION_NOISE, '');
  const fresh = all.slice(run.readFrom);
  run.readFrom = all.length;
  return fresh.length > OUTPUT_LIMIT ? `[… ${fresh.length - OUTPUT_LIMIT} earlier characters cut; the whole log is ${path.join(run.dir, 'out.log')}]\n${fresh.slice(-OUTPUT_LIMIT)}` : fresh;
}

function report(run, code) {
  const secs = Math.round((Date.now() - run.started) / 1000);
  const out = newOutput(run).trimEnd();
  if (run.cc) return liveReport(run, code, secs, out);
  const head = code === null
    ? `Still running after ${secs}s (command id ${run.id}). Call read_output to wait for more, send_input to answer a prompt, or stop_command to stop it.`
    : `Exited with code ${code} after ${secs}s (command id ${run.id}).`;
  return [head, run.note, run.windowId ? `It runs in its own Terminal window (window id ${run.windowId}), where the user can watch.` : null, out ? `Output:\n${out}` : 'No output.'].filter(Boolean).join('\n');
}

function liveReport(run, code, secs, out) {
  const cc = run.cc;
  const notice = cc.turn?.notice;
  if (notice) cc.turn.noticeShown = notice;
  if (notice) cc.turn.notice = null;   // told once; read_output waits again after this
  const head = code === null
    ? notice
      ? `Claude Code is waiting for an answer in its window (command id ${run.id}): "${notice}". Answer with send_input: "1" for Yes, "3" for No (or ask the user to choose in the window). Then read_output.`
      : `Claude Code is still working after ${secs}s (command id ${run.id}). Call read_output to wait for more, or stop_command to interrupt it.`
    : code === 130 ? `Claude Code was interrupted after ${secs}s (command id ${run.id}). It is still open: claude_code with continue_session gives it a new instruction.`
      : code === 0 && cc.alive ? `Claude Code finished the task in ${secs}s (command id ${run.id}). Its window stays open; claude_code with continue_session types a follow-up into it.`
        : `Claude Code quit with code ${code} after ${secs}s (command id ${run.id}).`;
  return [head, run.note, `It runs in its own Terminal window (window id ${cc.windowId}), where the user can watch and step in.`, out ? `What it did:\n${out}` : 'Nothing to report from it yet.'].filter(Boolean).join('\n');
}

function find(id) {
  const run = runs.get(String(id));
  if (!run) throw new Error(`No command with id ${id}. Each run_command result names its id.`);
  return run;
}

// Kill the command and everything it started.
function kill(run) {
  if (run.cc) { run.cc.interrupt().finally(() => run.cc.quit()); return; }
  let pid = null;
  try { pid = Number(fs.readFileSync(path.join(run.dir, 'pid'), 'utf8').trim()) || null; } catch { /* not started yet */ }
  if (run.child) { try { process.kill(-run.child.pid, 'SIGTERM'); } catch { /* gone */ } return; }
  if (!pid) return;
  execFile('pkill', ['-TERM', '-P', String(pid)], () => { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } });
}

// The prompt is passed through a file, so no quoting can break it. Claude Code runs without its full-screen
// interface, through claude-stream.js, which streams what it does into the window as it works (a bare
// `claude -p` prints nothing until it is done) and ends with its final answer. Edits are accepted; shell
// commands only if allowed. The wrapper runs on the app's own runtime, so Node need not be installed.
const STREAM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-stream.js');
// It may read and edit the whole workspace (--add-dir), not only the project folder: the spec and data other
// agents wrote are usually there.
function claudeCommand(dir, { prompt, allow_commands, continue_session, model }) {
  const file = path.join(dir, 'prompt.txt');
  fs.writeFileSync(file, String(prompt));
  return [
    `${HIDDEN ? '' : 'SENJU_COLOR=1 '}ELECTRON_RUN_AS_NODE=1 ${q(process.execPath)} ${q(STREAM)} ${q(file)}`,
    process.env.SENJU_CLAUDE ? `--claude ${q(process.env.SENJU_CLAUDE)}` : null,
    `--summary ${q(path.join(dir, 'summary.log'))}`,
    `--add-dir ${q(WORKSPACE)}`,
    '--permission-mode acceptEdits',
    allow_commands ? '--allowedTools Bash' : null,
    continue_session ? '--continue' : null,
    model ? `--model ${q(model)}` : null,
  ].filter(Boolean).join(' ');
}

const TOOLS = [
  {
    name: 'run_command',
    description: 'Run a shell command (zsh) and get back its exit code and output as text. It opens a new Terminal window the user can watch; it never types into a terminal that was already open. Waits up to timeout_seconds (default 120); a command still running then (a dev server, a long build) keeps running, and you read it later with read_output. Not for full-screen programs (vim, top) or programs that need a real keyboard.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line, e.g. "npm install && npm test"' },
        cwd: { type: 'string', description: 'Folder to run it in: absolute, ~/…, or relative to the workspace. Default: the workspace' },
        timeout_seconds: { type: 'number', description: 'How long to wait for it to finish before returning (default 120, at most 1800)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'claude_code',
    description: 'Give a coding task to Claude Code (the claude CLI) in a project folder and get back what it did and its final answer. It reads and edits files there itself. It opens Claude Code in a Terminal window of its own and types the task into its prompt box, where the user can watch; the window stays open afterwards. If it asks a permission question, the result says so: answer with send_input. By default it may edit files but not run shell commands; set allow_commands to let it run them (installs, tests, builds). Set continue_session to follow up in the same conversation (typed into the same window when it is still open). Takes minutes: it waits up to timeout_seconds (default 900); if still running, keep waiting with read_output.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task, written as you would to a developer: what to build or change, which files, how to check it' },
        cwd: { type: 'string', description: 'The project folder (created if missing): absolute, ~/…, or relative to the workspace' },
        allow_commands: { type: 'boolean', description: 'Let Claude Code run shell commands (npm install, tests). Default false' },
        continue_session: { type: 'boolean', description: 'Continue the most recent Claude Code conversation in this folder' },
        model: { type: 'string', description: 'Optional Claude model for Claude Code to use' },
        timeout_seconds: { type: 'number', description: 'How long to wait before returning (default 900, at most 1800)' },
      },
      required: ['prompt', 'cwd'],
    },
  },
  {
    name: 'read_output',
    description: 'Wait for a running command (by its id) and read what it printed since you last read. Returns when it ends or after wait_seconds (default 60).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, wait_seconds: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'send_input',
    description: 'Type a line into a running command and press Return, to answer a prompt it is waiting on (y/n, a choice). Then read_output.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
  },
  {
    name: 'stop_command',
    description: 'Stop a running command (and whatever it started), like pressing Ctrl-C.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const clampSecs = (v, dflt) => Math.min(1800, Math.max(1, Number(v) || dflt));

// Is the person at the keyboard right now (typed or clicked in the last two seconds)? Then a new window does not
// come to the front: that would take their keystrokes.
function userIdleSeconds() {
  return new Promise((resolve) => execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 3000 }, (err, out) => {
    const m = !err && String(out).match(/"HIDIdleTime"\s*=\s*(\d+)/);
    resolve(m ? Number(m[1]) / 1e9 : 99);
  }));
}

// Claude Code in its own interface: a Terminal window where Senju types `claude`, then the task into its prompt
// box, with the agent's cursor there. A follow-up (continue_session) is typed into the same window when it is
// still open in that folder. Returns [text, isError].
async function claudeWindow(args, prompt, cwd, signal, emit) {
  const open = [...runs.values()].filter((r) => r.cc?.alive);
  let run = args.continue_session ? open.find((r) => r.cwd === cwd && r.cc.idle) : null;
  // A finished Claude Code window closes when a new one opens, so they do not pile up. One still working stays.
  for (const r of open) if (r !== run && r.cc.idle) r.cc.close();
  if (run) {
    run.cc.emit = emit;
    run.started = Date.now();
    run.readFrom = fs.readFileSync(run.cc.summaryFile, 'utf8').length;
  } else {
    const id = String(++seq);
    const dir = path.join(ROOT, id);
    fs.mkdirSync(dir);
    const cc = new ClaudeWindow({ dir, cwd, feeder: FEEDER, osascript, emit, claudeBin: process.env.SENJU_CLAUDE });
    run = { id, dir, command: 'claude', cwd, title: 'Claude Code', cc, started: Date.now(), readFrom: 0, logFile: cc.summaryFile, kind: 'claude-window' };
    runs.set(id, run);
    // It may read and edit the whole workspace (the spec and data other agents wrote), and edit files without
    // asking. Shell commands only when allowed; otherwise they are refused instead of waiting on a question.
    const flags = [`--permission-mode acceptEdits --add-dir ${q(WORKSPACE)}`, args.allow_commands ? '--allowedTools Bash' : '--disallowedTools Bash'].join(' ');
    try { await cc.open(flags, (await userIdleSeconds()) >= 2); } catch (err) { runs.delete(id); return [`Could not open a Terminal window for Claude Code: ${err.message}`, true]; }
    const extra = `${args.continue_session ? ' --continue' : ''}${args.model ? ` --model ${String(args.model).replace(/[^\w.:-]/g, '')}` : ''}`;
    const problem = await cc.startClaude(extra);
    if (problem === 'missing') return [`Claude Code is not installed on this computer (the claude command is missing). Ask the user to install it: npm install -g @anthropic-ai/claude-code`, true];
    if (problem) return [`${problem}\n\nThe window is open (window id ${cc.windowId}); ask the user to finish this in it, then try again.`, true];
  }
  try {
    if (!(await run.cc.submit(prompt))) return [`The task was typed into Claude Code (window id ${run.cc.windowId}) but it did not start working on it. Look at the window, or ask the user.`, true];
  } catch (err) { return [String(err.message ?? err), true]; }
  const code = await wait(run, clampSecs(args.timeout_seconds, 900), signal);
  return [report(run, code), code !== null && code !== 0];
}

async function call(name, args = {}, signal = null, emit = () => {}) {
  if (name === 'run_command') {
    const command = String(args.command ?? '').trim();
    if (!command) return text('Give a command.', true);
    const run = await start(command, folder(args.cwd), 'Senju');
    return text(report(run, await wait(run, clampSecs(args.timeout_seconds, 120), signal)));
  }
  if (name === 'claude_code') {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return text('Give Claude Code a task.', true);
    const cwd = path.resolve(WORKSPACE, String(args.cwd ?? '.').replace(/^~(?=$|\/)/, os.homedir()));
    fs.mkdirSync(cwd, { recursive: true });
    if (!HIDDEN) return text(...await claudeWindow(args, prompt, cwd, signal, emit));
    const dir = fs.mkdtempSync(path.join(ROOT, 'claude-'));
    const shown = `claude "${prompt.replace(/\s+/g, ' ').slice(0, 90)}${prompt.length > 90 ? '…' : ''}"${args.allow_commands ? ' (may run commands)' : ''}`;
    const run = await start(claudeCommand(dir, { ...args, prompt }), cwd, 'Claude Code · Senju', shown, 'claude');
    run.logFile = path.join(dir, 'summary.log');
    const code = await wait(run, clampSecs(args.timeout_seconds, 900), signal);
    const out = report(run, code);
    if (code === 127 || /command not found: claude|claude: command not found/.test(out)) return text(`${out}\n\nClaude Code is not installed on this computer (the claude command is missing). Ask the user to install it: npm install -g @anthropic-ai/claude-code`, true);
    return text(out, code !== null && code !== 0);
  }
  if (name === 'read_output') {
    const run = find(args.id);
    return text(report(run, await wait(run, clampSecs(args.wait_seconds, 60), signal)));
  }
  if (name === 'send_input') {
    const run = find(args.id);
    if (status(run) !== null) return text(`Command ${run.id} has already ended.`, true);
    if (run.cc) { run.cc.emit = emit; await run.cc.typeAt([[25, String(args.text ?? '')], [0, '\r']]); }
    else if (run.child) run.child.stdin.write(`${args.text ?? ''}\n`);
    else if (run.windowId) await osascript(`tell application "Terminal" to do script ${asString(String(args.text ?? ''))} in selected tab of window id ${run.windowId}`);
    else return text('That command has no input to type into.', true);
    await sleep(500);
    return text(report(run, status(run)));
  }
  if (name === 'stop_command') {
    const run = find(args.id);
    if (run.cc) { await run.cc.interrupt(); return text(report(run, status(run))); }
    if (status(run) === null) kill(run);
    return text(report(run, await wait(run, 5)));
  }
  return text(`Unknown tool ${name}`, true);
}

const server = new Server({ name: 'senju-terminal', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  // Where the agent's cursor should be (the window line being typed into) goes back to the app as progress.
  const token = req.params._meta?.progressToken;
  let n = 0;
  const emit = token == null || !extra?.sendNotification ? () => {} : (point) => {
    extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: JSON.stringify({ point }) } }).catch(() => {});
  };
  try { return await call(req.params.name, req.params.arguments ?? {}, extra?.signal, emit); } catch (err) { return text(String(err?.message ?? err), true); }
});

// Leave nothing behind: stop commands still running in the background and remove the logs.
function cleanup() {
  for (const run of runs.values()) {
    if (run.cc) { if (run.cc.turn && !run.cc.turn.done) run.cc.quit(); else try { fs.writeFileSync(path.join(run.cc.keysDir, 'quit'), ''); } catch { /* gone */ } }
    else if (run.child && status(run) === null) kill(run);
  }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

await server.connect(new StdioServerTransport());
