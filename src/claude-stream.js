// Claude Code, shown as it works. The terminal server runs this in a Terminal window in place of a bare
// `claude -p`, which prints nothing until it is completely done (a build can look frozen for minutes).
// It starts claude with streaming JSON output and shows, live:
// - what Claude Code says, as it writes it;
// - each tool it uses (→ Write app.js, → Bash npm test), and the code itself as it is typed into a file;
// - the last lines a command printed, and anything that failed;
// - a summary at the end, then its final answer.
// The agent gets a shorter account (--summary <file>): the same, without the code and command output, which it
// would otherwise pay to read. Exits with claude's own exit code (1 if claude reported an error).
//
// Usage: claude-stream.js <prompt-file> [--claude <path>] [--summary <file>] [claude flags…]
// SENJU_COLOR=1 colours the window even though its output is piped (through tee, into the log).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const promptFile = argv.shift();
const option = (name) => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const bin = option('--claude') ?? 'claude';
const summaryFile = option('--summary');
const prompt = fs.readFileSync(promptFile, 'utf8');

const color = process.stdout.isTTY || process.env.SENJU_COLOR === '1';
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2'), bold = paint('1'), red = paint('31'), green = paint('32');
const short = (s, n = 140) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Two outputs: the window (everything) and the agent's summary (no code, no command output).
const summary = summaryFile ? fs.createWriteStream(summaryFile, { flags: 'a' }) : null;
let midLine = false;   // the window has a line in progress
const show = (s) => { if (!s) return; process.stdout.write(s); midLine = !s.endsWith('\n'); };
const note = (s) => summary?.write(s.replace(/\x1b\[[0-9;]*m/g, ''));
const both = (s) => { show(s); note(s); };
const endLine = () => { if (midLine) { process.stdout.write('\n'); midLine = false; } };

// One line naming a tool call: the file it touches, the command it runs, the pattern it searches for.
function describe(name, input = {}) {
  const file = input.file_path ?? input.path ?? input.notebook_path;
  const what = file ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? '';
  return `→ ${name}${what ? ` ${short(what, 120)}` : ''}`;
}
const unescape = (raw) => { try { return JSON.parse(`"${raw}"`); } catch { return raw.replace(/\\n/g, ' ').replace(/\\(.)/g, '$1'); } };
// The file or command named in a tool call's input while it is still being written (partial JSON).
const early = (json) => { const m = json.match(/"(?:file_path|path|notebook_path|command|pattern|url)"\s*:\s*"((?:[^"\\]|\\.)*)"/); return m ? unescape(m[1]) : null; };

// The text of a file being written (Write's content, Edit's new_string), decoded from the partial JSON as it
// streams in, so it can be shown a few characters at a time.
const CODE_FIELD = /"(content|new_string|new_source)"\s*:\s*"/g;
class CodeStream {
  constructor() { this.json = ''; this.pos = -1; this.done = false; this.lines = 0; this.chars = 0; }
  feed(chunk) {
    this.json += chunk;
    if (this.done) return '';
    if (this.pos < 0) {
      CODE_FIELD.lastIndex = 0;
      const m = CODE_FIELD.exec(this.json);
      if (!m) return '';
      this.pos = m.index + m[0].length;
    }
    let out = '';
    const s = this.json;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === '"') { this.done = true; break; }
      if (c !== '\\') { out += c; this.pos++; continue; }
      const e = s[this.pos + 1];
      if (e === undefined) break;                       // the rest of the escape has not arrived yet
      if (e === 'u') {
        if (this.pos + 6 > s.length) break;
        out += String.fromCharCode(parseInt(s.slice(this.pos + 2, this.pos + 6), 16) || 0x3f);
        this.pos += 6;
        continue;
      }
      out += { n: '\n', t: '\t', r: '', b: '', f: '' }[e] ?? e;
      this.pos += 2;
    }
    this.chars += out.length;
    this.breaks = (this.breaks ?? 0) + (out.match(/\n/g) ?? []).length;
    if (out) this.last = out.at(-1);
    this.lines = this.breaks + (this.last && this.last !== '\n' ? 1 : 0);   // a final newline ends a line, not starts one
    return out;
  }
}
const GUTTER = dim('  │ ');
// Code is shown dimmed behind a gutter, line by line, so it reads as a file being typed, not as Claude talking.
// A line break is held until more text follows, so a file's final newline leaves no empty gutter line.
const codeOut = (b, text) => {
  let s = b.coding ? '' : GUTTER;
  b.coding = true;
  for (const [i, part] of text.split('\n').entries()) {
    if (i > 0) b.heldBreaks = (b.heldBreaks ?? 0) + 1;
    if (!part) continue;
    if (b.heldBreaks) { s += `\n${GUTTER}`.repeat(b.heldBreaks); b.heldBreaks = 0; }
    s += dim(part);
  }
  show(s);
};
let lastText = '';       // Claude's latest message, so its final answer is not shown twice
let lastTool = false;    // the block before was a tool call: a blank line before Claude talks again

let streamed = false;   // partial messages arrive: show from those, not from the whole messages after
let block = null;       // the content block being streamed
const tools = new Map(); // tool_use id -> name, to show results under their call

function onStreamEvent(ev) {
  streamed = true;
  if (ev.type === 'content_block_start') {
    const cb = ev.content_block ?? {};
    if (cb.type === 'tool_use') { endLine(); block = { kind: 'tool', id: cb.id, name: cb.name, json: '', named: false, code: new CodeStream(), coding: false }; tools.set(cb.id, cb.name); }
    else if (cb.type === 'text') { endLine(); if (lastTool) show('\n'); block = { kind: 'text', text: '' }; }
    else block = { kind: cb.type };
    lastTool = cb.type === 'tool_use';
  } else if (ev.type === 'content_block_delta') {
    const d = ev.delta ?? {};
    if (d.type === 'text_delta' && d.text) { both(d.text); if (block?.kind === 'text') block.text += d.text; }
    else if (d.type === 'input_json_delta' && block?.kind === 'tool') {
      const chunk = d.partial_json ?? '';
      block.json += chunk;
      if (!block.named) {
        const what = early(block.json);
        if (what) { both(`${bold(`→ ${block.name}`)} ${short(what, 120)}\n`); block.named = true; }
      }
      const text = block.code.feed(chunk);
      if (text) codeOut(block, text);
    }
  } else if (ev.type === 'content_block_stop') {
    if (block?.kind === 'text') { endLine(); note('\n'); if (block.text.trim()) lastText = block.text.trim(); }
    else if (block?.kind === 'tool') {
      endLine();
      let input = {};
      try { input = JSON.parse(block.json || '{}'); } catch { /* the name alone */ }
      if (!block.named) both(`${bold(describe(block.name, input))}\n`);
      if (block.coding) {
        const n = block.code.chars;
        const size = `${block.code.lines} line${block.code.lines === 1 ? '' : 's'}, ${n < 1000 ? n : `${(n / 1000).toFixed(1)}k`} characters`;
        show(dim(`  └ ${size}\n`));
        note(`   (${size})\n`);
      }
    }
    block = null;
  }
}

// Without partial messages (an older claude), show each whole message instead.
function onAssistant(msg) {
  for (const b of msg?.content ?? []) if (b.type === 'tool_use') tools.set(b.id, b.name);
  if (streamed) return;
  for (const b of msg?.content ?? []) {
    if (b.type === 'text' && b.text.trim()) { endLine(); both(`${b.text.trim()}\n`); }
    if (b.type === 'tool_use') { endLine(); both(`${bold(describe(b.name, b.input))}\n`); }
  }
}

// Tool results: failures for everyone; the last lines a command printed, for the window.
function onToolResults(msg) {
  for (const b of Array.isArray(msg?.content) ? msg.content : []) {
    if (b.type !== 'tool_result') continue;
    const text = Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join('\n') : String(b.content ?? '');
    endLine();
    if (b.is_error) { both(red(`   ✗ ${short(text, 200)}\n`)); continue; }
    if (tools.get(b.tool_use_id) === 'Bash' && text.trim()) {
      const lines = text.trimEnd().split('\n');
      const tail = lines.slice(-6).map((l) => `${GUTTER}${dim(l.slice(0, 160))}`).join('\n');
      show(`${lines.length > 6 ? `${GUTTER}${dim(`… ${lines.length - 6} more lines`)}\n` : ''}${tail}\n`);
    }
  }
}

let result = null;
function onLine(line) {
  let e;
  try { e = JSON.parse(line); } catch { if (line.trim()) { endLine(); both(`${line}\n`); } return; }
  if (e.type === 'system' && e.subtype === 'init') both(dim(`Claude Code started${e.model ? ` (${e.model})` : ''}. Watching it work…\n\n`));
  else if (e.type === 'stream_event') onStreamEvent(e.event ?? {});
  else if (e.type === 'assistant') onAssistant(e.message);
  else if (e.type === 'user') onToolResults(e.message);
  else if (e.type === 'result') result = e;
}

const child = spawn(bin, ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...argv], { stdio: ['ignore', 'pipe', 'inherit'] });
const finish = (code) => { if (summary) summary.end(() => process.exit(code)); else process.exit(code); };
let failed = false;
child.on('error', (err) => {
  failed = true;
  both(err.code === 'ENOENT' ? 'command not found: claude\n' : `Could not start claude: ${err.message}\n`);
  finish(err.code === 'ENOENT' ? 127 : 1);
});
readline.createInterface({ input: child.stdout }).on('line', onLine);
// Stopped (the job was stopped, stop_command, Ctrl-C, or its window was closed): stop claude too, which is this
// process's child and would otherwise carry on by itself.
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => {
  if (stopping) return;
  stopping = true;
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  endLine();
  show(red('\n── Stopped.\n')); note('\n── Stopped.\n');
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(143); }, 1500).unref();
});
child.on('close', (code) => {
  if (failed) return;   // the error handler reports a failed start
  endLine();
  if (result) {
    const secs = Math.round((result.duration_ms ?? 0) / 1000);
    const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    const cost = Number.isFinite(result.total_cost_usd) ? ` · $${result.total_cost_usd.toFixed(2)}` : '';
    const head = `── ${result.is_error ? 'Stopped with an error' : 'Done'} in ${took} · ${result.num_turns ?? '?'} turns${cost}`;
    show(`\n${result.is_error ? red(head) : green(head)}\n`); note(`\n${head}\n`);
    // Its final answer is usually its last message, already shown: then it is not repeated.
    if (result.result && result.result.trim() !== lastText) both(`\nFinal answer:\n${result.result}\n`);
  }
  const c = code ?? 1;
  finish(c !== 0 ? c : result?.is_error ? 1 : 0);
});
