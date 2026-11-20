// Claude Code, shown as it works. The terminal server runs this in a Terminal window in place of a bare
// `claude -p`, which prints nothing until it is completely done (a build can look frozen for minutes).
// This starts claude with streaming JSON output and prints a readable log as it goes: what Claude Code says,
// each tool it uses (→ Write app.js, → Bash npm test), progress while it writes a long file, and a summary at
// the end, followed by its final answer. It exits with claude's own exit code (1 if claude reported an error).
//
// Usage: claude-stream.js <prompt-file> [--claude <path>] [claude flags…]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const promptFile = argv.shift();
let bin = 'claude';
const at = argv.indexOf('--claude');
if (at >= 0) { bin = argv[at + 1]; argv.splice(at, 2); }
const prompt = fs.readFileSync(promptFile, 'utf8');

const tty = process.stdout.isTTY;
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
const out = (s) => process.stdout.write(s);
const short = (s, n = 140) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// One line naming a tool call: the file it touches, the command it runs, the pattern it searches for.
function describe(name, input = {}) {
  const file = input.file_path ?? input.path ?? input.notebook_path;
  const what = file ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? '';
  return `→ ${name}${what ? ` ${short(what, 120)}` : ''}`;
}
// The file or command named in a tool call's input while it is still being written (partial JSON).
const early = (json) => json.match(/"(?:file_path|path|command|pattern|url)"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\(.)/g, '$1') ?? null;

let streamed = false;        // partial messages arrive: print from those, not from the whole messages after
let block = null;            // the content block being streamed: { kind, name, json, named, shownAt }
let midLine = false;         // text was printed without a newline yet
const endLine = () => { if (midLine) { out('\n'); midLine = false; } };
const STEP = 4000;           // a progress line every this many characters of a tool call being written

function onStreamEvent(ev) {
  streamed = true;
  if (ev.type === 'content_block_start') {
    const cb = ev.content_block ?? {};
    if (cb.type === 'tool_use') { endLine(); block = { kind: 'tool', name: cb.name, json: '', named: false, shownAt: 0 }; }
    else if (cb.type === 'text') block = { kind: 'text' };
    else block = { kind: cb.type };
  } else if (ev.type === 'content_block_delta') {
    const d = ev.delta ?? {};
    if (d.type === 'text_delta' && d.text) { out(d.text); midLine = !d.text.endsWith('\n'); }
    else if (d.type === 'input_json_delta' && block?.kind === 'tool') {
      block.json += d.partial_json ?? '';
      if (!block.named) {
        const name = early(block.json);
        if (name) { out(`${bold(`→ ${block.name}`)} ${short(name, 120)}\n`); block.named = true; }
      }
      if (block.json.length - block.shownAt >= STEP) {
        block.shownAt = block.json.length;
        out(dim(`   … ${Math.round(block.json.length / 1000)}k characters so far\n`));
      }
    }
  } else if (ev.type === 'content_block_stop') {
    if (block?.kind === 'text') endLine();
    else if (block?.kind === 'tool' && !block.named) {
      let input = {};
      try { input = JSON.parse(block.json || '{}'); } catch { /* print the name alone */ }
      out(`${bold(describe(block.name, input))}\n`);
    }
    block = null;
  }
}

// Without partial messages (an older claude), print each whole message instead.
function onAssistant(msg) {
  if (streamed) return;
  for (const b of msg?.content ?? []) {
    if (b.type === 'text' && b.text.trim()) { endLine(); out(`${b.text.trim()}\n`); }
    if (b.type === 'tool_use') { endLine(); out(`${bold(describe(b.name, b.input))}\n`); }
  }
}

function onToolResults(msg) {
  for (const b of Array.isArray(msg?.content) ? msg.content : []) {
    if (b.type !== 'tool_result' || !b.is_error) continue;
    const text = Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join(' ') : b.content;
    endLine();
    out(red(`   ✗ ${short(text, 200)}\n`));
  }
}

let result = null;
function onLine(line) {
  let e;
  try { e = JSON.parse(line); } catch { if (line.trim()) { endLine(); out(`${line}\n`); } return; }
  if (e.type === 'system' && e.subtype === 'init') out(dim(`Claude Code started${e.model ? ` (${e.model})` : ''}. Watching it work…\n`));
  else if (e.type === 'stream_event') onStreamEvent(e.event ?? {});
  else if (e.type === 'assistant') onAssistant(e.message);
  else if (e.type === 'user') onToolResults(e.message);
  else if (e.type === 'result') result = e;
}

const child = spawn(bin, ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...argv], { stdio: ['ignore', 'pipe', 'inherit'] });
child.on('error', (err) => {
  if (err.code === 'ENOENT') { out(`command not found: claude\n`); process.exit(127); }
  out(`Could not start claude: ${err.message}\n`);
  process.exit(1);
});
readline.createInterface({ input: child.stdout }).on('line', onLine);
child.on('close', (code) => {
  endLine();
  if (result) {
    const secs = Math.round((result.duration_ms ?? 0) / 1000);
    const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    const cost = Number.isFinite(result.total_cost_usd) ? ` · $${result.total_cost_usd.toFixed(2)}` : '';
    out(dim(`\n── ${result.is_error ? 'Stopped with an error' : 'Done'} in ${took} · ${result.num_turns ?? '?'} turns${cost}\n`));
    if (result.result) out(`\nFinal answer:\n${result.result}\n`);
  }
  const c = code ?? 1;
  process.exit(c !== 0 ? c : result?.is_error ? 1 : 0);
});
