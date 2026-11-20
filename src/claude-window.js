// Claude Code the way a person uses it: Senju opens a Terminal window, types `claude`, and types the task into
// Claude Code's own prompt box, with the agent's ghost cursor on the window while it types. Claude Code then works
// in its full interface, where the user can watch and step in, and the window stays open for follow-ups.
//
// How the pieces fit:
// - Keys: a small Perl helper runs in the window's own shell and pushes characters into that terminal's input
//   (TIOCSTI), as if they were typed there. Only that window gets them: never the app the user is in, and the
//   user's own typing elsewhere is not disturbed.
// - Knowing what Claude Code does: it is started with hooks (--settings) that write each event to a file:
//   SessionStart (ready, and where its transcript is), UserPromptSubmit (the task arrived), Notification
//   (it asks for permission), Stop (the task is done, with its last message). The agent's account of the work is
//   read from the transcript.
// - The cursor: the terminal server sends points (screen positions of the window's lines) back to the app as
//   progress notifications, and the app moves the agent's cursor there.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
const short = (s, n = 140) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// The key helper. It reads chunks from in-<n>.json files ([[ms between characters, text], …]) in its folder and
// types them into its terminal, then deletes the file to say it is done. It quits when told to (quit) or when the
// folder or the terminal goes away. Written out at start-up because Perl cannot read it from inside the app's archive.
const FEEDER = String.raw`use strict; use JSON::PP; use Encode;
# It runs in the background of the shell, and a background process typing into its terminal is stopped (SIGTTOU)
# unless it ignores that.
$SIG{TTOU} = 'IGNORE';
my $dir = shift; open(my $t, '<', '/dev/tty') or exit 1;
open(my $r, '>', "$dir/ready"); print $r $$; close $r;
my $n = 0;
while (-d $dir && !-e "$dir/quit") {
  my $f = "$dir/in-$n.json";
  unless (-e "$f.ready") { select(undef, undef, undef, 0.04); next; }
  open(my $h, '<:raw', $f) or exit 3; local $/; my $json = <$h>; close $h;
  my $chunks = JSON::PP->new->utf8->decode($json);
  for my $c (@$chunks) {
    my ($ms, $text) = @$c; my $sent = 0;
    for my $ch (split //, $text) {
      for my $b (split //, Encode::encode('UTF-8', $ch)) { ioctl($t, 0x80017472, $b) or exit 2; $sent++; }
      if ($ms > 0) { select(undef, undef, undef, $ms / 1000); }
      elsif ($sent % 200 == 0) { select(undef, undef, undef, 0.015); }   # a long paste: let the input queue drain
    }
  }
  unlink "$f.ready", $f; $n++;
}
`;

export function writeFeeder(root) {
  const file = path.join(root, 'tty-feeder.pl');
  fs.writeFileSync(file, FEEDER);
  return file;
}

// The hooks Claude Code runs: every event is appended, one JSON line each, to hooks.jsonl. SessionStart also notes
// Claude Code's own pid (the hook's parent), so it can be stopped.
export function writeHooks(dir) {
  const log = q(path.join(dir, 'hooks.jsonl'));
  const append = `{ cat; echo; } >> ${log}`;
  const settings = {
    hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'].map((ev) => [ev, [{
      hooks: [{ type: 'command', command: ev === 'SessionStart' ? `echo $PPID > ${q(path.join(dir, 'claude.pid'))}; ${append}` : append }],
    }]])),
  };
  const file = path.join(dir, 'hooks.json');
  fs.writeFileSync(file, JSON.stringify(settings));
  return file;
}

// What Claude Code did since a point in its transcript, as short lines for the agent: what it said, each tool it
// used (→ Write index.html, → Bash npm test), and what failed. No code and no command output.
export function account(entries, cwd = null) {
  const rel = (f) => (cwd && typeof f === 'string' && f.startsWith(`${cwd}/`) ? f.slice(cwd.length + 1) : f);
  const lines = [];
  const names = new Map();
  for (const e of entries) {
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (e.type === 'assistant' && b.type === 'text' && b.text?.trim()) lines.push(b.text.trim());
      else if (e.type === 'assistant' && b.type === 'tool_use') {
        names.set(b.id, b.name);
        const i = b.input ?? {};
        const what = rel(i.file_path ?? i.path ?? i.notebook_path) ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.description ?? '';
        lines.push(`→ ${b.name}${what ? ` ${short(what, 120)}` : ''}`);
      } else if (e.type === 'user' && b.type === 'tool_result' && b.is_error) {
        const text = Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join(' ') : String(b.content ?? '');
        lines.push(`   ✗ ${names.get(b.tool_use_id) ?? 'tool'}: ${short(text, 200)}`);
      }
    }
  }
  return lines;
}

// Text typed into Claude Code's prompt box. Tabs would trigger completion and other control characters act as
// keys, so they go; a leading / ! or # would start a command, shell mode or memory, so a space goes first.
export function promptKeys(prompt) {
  let text = String(prompt).replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').trim();
  if (/^[/!#]/.test(text)) text = ` ${text}`;
  // Typed at a readable pace, the whole task in about six seconds at most; a long task's first part is typed and
  // the rest pasted, as a person would.
  const TYPED = 900;
  if (text.length <= TYPED) return [[Math.max(3, Math.min(28, Math.round(6000 / Math.max(1, text.length)))), `${text} `]];
  return [[6, text.slice(0, 300)], [0, `\x1b[200~${text.slice(300)}\x1b[201~`], [0, ' ']];
}
export const typedChars = (chunks) => chunks.reduce((n, [ms, t]) => n + (ms > 0 ? [...t].length : 0), 0);
export const typingMs = (chunks) => chunks.reduce((n, [ms, t]) => n + ms * [...t].length, 0);

// A live Claude Code window: its shell, the key helper, the hooks and the turn in progress.
export class ClaudeWindow {
  constructor({ dir, cwd, feeder, osascript, emit, claudeBin }) {
    Object.assign(this, { dir, cwd, feeder, osascript, claudeBin: claudeBin || 'claude' });
    this.emit = emit ?? (() => {});
    this.keysDir = path.join(dir, 'keys');
    fs.mkdirSync(this.keysDir, { recursive: true });
    this.hooksFile = writeHooks(dir);
    this.hookLog = path.join(dir, 'hooks.jsonl');
    this.exitFile = path.join(dir, 'exit');
    this.summaryFile = path.join(dir, 'summary.log');
    fs.writeFileSync(this.summaryFile, '');
    this.hookPos = 0;
    this.keySeq = 0;
    this.windowId = null;
    this.session = null;      // { id, transcript } from SessionStart
    this.turn = null;         // { started, submitted, done, answer, notice, from, seen }
  }

  // ---- The Terminal window ----
  async open(flags, front = true) {
    // The window's shell gets a `claude` that starts Claude Code with Senju's flags, so all that is typed is `claude`.
    const fn = `claude() { command ${this.claudeBin === 'claude' ? 'claude' : q(this.claudeBin)} --settings ${q(this.hooksFile)} ${flags} "$@"; echo $? > ${q(this.exitFile)}; }`;
    const line = ` cd ${q(this.cwd)} && ${fn}; (perl ${q(this.feeder)} ${q(this.keysDir)} &); clear`;
    const wid = await this.osascript(`tell application "Terminal"
  ${front ? 'activate\n  ' : ''}set t to do script ${as(line)}
  delay 0.2
  set w to first window whose tabs contains t
  set custom title of t to "Claude Code · Senju"
  return id of w
end tell`);
    this.windowId = Number(wid) || null;
    if (!this.windowId) throw new Error('Terminal did not open a window.');
    const until = Date.now() + 10_000;
    while (!fs.existsSync(path.join(this.keysDir, 'ready')) && Date.now() < until) await sleep(100);
    if (!fs.existsSync(path.join(this.keysDir, 'ready'))) throw new Error('The Terminal window did not start its shell.');
    await sleep(400);   // the prompt draws after clear
    // The cursor goes to the new window, as if it had opened it.
    const g = await this.geometry();
    if (g) this.emit(this.spot(g, Math.floor(g.rows / 3), Math.floor(g.cols / 2), 'click'));
    await sleep(350);
  }

  // Bounds and rows/columns of the window, for placing the cursor on a line.
  async geometry() {
    try {
      const out = await this.osascript(`tell application "Terminal"
  set w to window id ${this.windowId}
  set b to bounds of w
  set t to selected tab of w
  return (item 1 of b as text) & "," & (item 2 of b as text) & "," & (item 3 of b as text) & "," & (item 4 of b as text) & "," & (number of rows of t as text) & "," & (number of columns of t as text)
end tell`);
      const [l, t, r, b, rows, cols] = out.split(',').map(Number);
      return [l, t, r, b, rows, cols].every(Number.isFinite) && rows > 0 && cols > 0 ? { l, t, r, b, rows, cols } : null;
    } catch { return null; }
  }

  async screen() {
    try { return await this.osascript(`tell application "Terminal" to get contents of selected tab of window id ${this.windowId}`); } catch { return ''; }
  }

  // A screen point on a line of the window (row from the top, column from the left), in the shape the app's cursor
  // expects: on screen, and within the window, so the cursor stays with the window if it moves.
  spot(g, row, col, verb, chars = 0, ms = 0) {
    const TITLE = 28;
    const lineH = (g.b - g.t - TITLE - 4) / g.rows;
    const charW = (g.r - g.l - 10) / g.cols;
    const y = Math.round(g.t + TITLE + 2 + (row + 0.5) * lineH);
    const span = Math.max(1, Math.min(g.cols - col, chars || 1));
    const x = verb === 'type' ? Math.round(g.l + 5 + charW * (col + span / 2)) : Math.round(g.l + 5 + charW * (col + 0.5));
    const p = { verb, screenX: x, screenY: y, x: x - g.l, y: y - g.t, windowW: g.r - g.l, windowH: g.b - g.t };
    return verb === 'type' ? { ...p, w: Math.round(span * charW + 16), chars, typeMs: ms } : p;
  }

  // Type chunks into the window and wait until they are all in.
  async keys(chunks) {
    const n = this.keySeq++;
    const file = path.join(this.keysDir, `in-${n}.json`);
    fs.writeFileSync(file, JSON.stringify(chunks));
    fs.writeFileSync(`${file}.ready`, '');
    const until = Date.now() + typingMs(chunks) + 15_000;
    while (fs.existsSync(`${file}.ready`) && Date.now() < until) await sleep(50);
    if (fs.existsSync(`${file}.ready`)) throw new Error('Could not type into the Claude Code window (its terminal has gone).');
  }

  // Type with the cursor on a line: the last line with text (the shell prompt), or the line `find` matches.
  async typeAt(chunks, find = null) {
    const g = await this.geometry();
    if (g) {
      const lines = (await this.screen()).replace(/\n+$/, '').split('\n');
      let row = -1;
      if (find) for (let i = lines.length - 1; i >= 0; i--) if (find.test(lines[i])) { row = i; break; }
      if (row < 0) row = Math.max(0, lines.length - 1);
      const line = lines[row] ?? '';
      const col = Math.min(g.cols - 1, find ? Math.max(0, line.search(/❯|>/) + 2) : line.replace(/\s+$/, '').length + 1);
      const chars = typedChars(chunks);
      this.emit(this.spot(g, Math.min(row, g.rows - 1), col, 'type', chars, typingMs(chunks)));
      await sleep(230);   // the cursor's glide lands before the first letter
    }
    await this.keys(chunks);
  }

  // ---- Hooks ----
  // Read new hook events: start, the task arriving, a permission request, done.
  poll() {
    let text = '';
    try { text = fs.readFileSync(this.hookLog, 'utf8'); } catch { return; }
    const fresh = text.slice(this.hookPos);
    const end = fresh.lastIndexOf('\n');
    if (end < 0) return;
    this.hookPos += end + 1;
    for (const line of fresh.slice(0, end).split('\n')) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      const ev = e.hook_event_name;
      if (ev === 'SessionStart') this.session = { id: e.session_id, transcript: e.transcript_path, cwd: e.cwd };
      else if (ev === 'UserPromptSubmit' && this.turn && !this.turn.submitted) { this.turn.submitted = Date.now(); this.turn.from = this.transcriptLines().length; }
      else if (ev === 'Notification' && this.turn?.submitted && !this.turn.done && !/waiting for your input/i.test(e.message ?? '') && e.notification_type !== 'idle_prompt') this.turn.notice = e.message || 'Claude Code is waiting for an answer in its window.';
      else if (ev === 'Stop' && this.turn?.submitted) { this.turn.done = Date.now(); this.turn.answer = e.last_assistant_message ?? null; this.turn.notice = null; }
      else if (ev === 'SessionEnd') this.ended = true;
    }
    this.writeAccount();
  }

  transcriptLines() {
    if (!this.session?.transcript) return [];
    try { return fs.readFileSync(this.session.transcript, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  }

  // Keep summary.log up to date with what Claude Code did in this turn, so read_output can hand it over as it goes.
  writeAccount() {
    const t = this.turn;
    if (!t?.submitted || t.from == null) return;
    const entries = this.transcriptLines().slice(t.from).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const lines = account(entries, this.session?.cwd ?? this.cwd);
    const add = lines.slice(t.seen ?? 0);
    t.seen = lines.length;
    if (add.length) fs.appendFileSync(this.summaryFile, `${add.join('\n')}\n`);
    if (t.done && !t.closed) {
      t.closed = true;
      const secs = Math.round((t.done - t.submitted) / 1000);
      const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
      const last = lines.filter((l) => !l.startsWith('→') && !l.startsWith('   ✗')).at(-1);
      fs.appendFileSync(this.summaryFile, `\n── Done in ${took}\n${t.answer && t.answer.trim() !== last ? `\nFinal answer:\n${t.answer.trim()}\n` : ''}`);
    }
  }

  exitCode() {
    try { const c = Number(fs.readFileSync(this.exitFile, 'utf8').trim()); return Number.isFinite(c) ? c : 1; } catch { return null; }
  }
  get alive() { return this.windowId != null && this.exitCode() === null && !this.closed; }
  get idle() { return this.alive && this.session && (!this.turn || this.turn.done || this.turn.stopped); }

  // ---- Starting Claude Code and giving it a task ----
  // Type `claude` at the shell prompt, then wait for Claude Code to be ready, answering its folder-trust question.
  // Returns null when ready, or what went wrong (with the screen, for the agent).
  async startClaude(extra = '') {
    await this.typeAt([[70, `claude${extra}`], [0, '\r']]);
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      this.poll();
      const code = this.exitCode();
      if (code !== null) return code === 127 ? 'missing' : `Claude Code exited (code ${code}) before it was ready.\nThe window shows:\n${tail(await this.screen())}`;
      const scr = await this.screen();
      // Its trust questions (the project folder, then the workspace it may also use) default to No. Choose Yes with
      // the cursor and confirm, for each one as it comes.
      if (!this.session && TRUST.test(scr) && Date.now() - (this.trustAt ?? 0) > 1500) {
        this.trustAt = Date.now();
        await this.chooseYes(scr);
        this.trustAt = Date.now();
      }
      if (this.session && /❯|>\s/.test(scr.split('\n').slice(-12).join('\n'))) { await sleep(600); return null; }
      await sleep(300);
    }
    return `Claude Code did not get to its prompt within a minute (it may need signing in or a first-run choice).\nThe window shows:\n${tail(await this.screen())}`;
  }

  async chooseYes(scr) {
    const lines = scr.split('\n');
    const row = lines.findIndex((l) => YES.test(l));
    if (row < 0) return;
    const g = await this.geometry();
    if (g) { this.emit(this.spot(g, row, Math.max(0, lines[row].search(/Yes/)) + 4, 'click')); await sleep(300); }
    // Move the selection (❯) down to the Yes line, checking the screen each step.
    for (let i = 0; i < 4; i++) {
      const now = (await this.screen()).split('\n');
      const sel = now.findIndex((l) => /^\s*❯/.test(l));
      const yes = now.findIndex((l) => YES.test(l));
      if (yes < 0) return;
      if (sel === yes) break;
      await this.keys([[0, sel >= 0 && sel > yes ? '\x1b[A' : '\x1b[B']]);
      await sleep(250);
    }
    await this.keys([[0, '\r']]);
    await sleep(500);
  }

  // Type the task into the prompt box and press Return; confirm it arrived.
  async submit(prompt) {
    this.turn = { started: Date.now(), submitted: 0, done: 0, answer: null, notice: null, from: null, seen: 0 };
    const chunks = promptKeys(prompt);
    await this.typeAt(chunks, /^\s*[│|]?\s*❯/);
    await sleep(250);
    await this.keys([[0, '\r']]);
    for (let i = 0; i < 2; i++) {
      const until = Date.now() + 5000;
      while (Date.now() < until) { this.poll(); if (this.turn.submitted) return true; await sleep(150); }
      await this.keys([[0, '\r']]);   // an open completion menu took the first Return
    }
    this.poll();
    return Boolean(this.turn.submitted);
  }

  // Interrupt the task in progress (Esc, as a person would); Claude Code stays open.
  async interrupt() {
    if (!this.turn || this.turn.done) return;
    await this.keys([[0, '\x1b']]).catch(() => {});
    this.turn.stopped = true;
  }

  pid() { try { return Number(fs.readFileSync(path.join(this.dir, 'claude.pid'), 'utf8').trim()) || null; } catch { return null; } }

  // Quit Claude Code and the key helper.
  quit() {
    const pid = this.pid();
    if (pid && this.exitCode() === null) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    try { fs.writeFileSync(path.join(this.keysDir, 'quit'), ''); } catch { /* folder gone */ }
  }

  // Quit and close the window (once nothing is left running in it, so Terminal does not ask).
  async close() {
    this.quit();
    this.closed = true;
    await sleep(800);
    if (this.windowId) await closeIdleWindow(this.osascript, this.windowId).catch(() => {});
  }
}

// Close a Terminal window only when nothing but its shell is left on it. Closing one that still runs something
// (a server started in the background, say) makes Terminal ask "terminate running processes?", and while that
// sheet is up Terminal answers no scripting at all: every later window would wait out its timeout. Terminal's
// own process list leaves out background jobs, so this asks ps about every process on the window's tty.
const SHELLS = new Set(['login', 'zsh', 'bash', 'sh', 'tee', 'cat', 'ps']);
export async function closeIdleWindow(osascript, windowId) {
  const id = Number(windowId);
  const tty = await osascript(`tell application "Terminal" to get tty of tab 1 of (first window whose id is ${id})`);
  if (!/^\/dev\/ttys\d+$/.test(tty)) return false;
  const procs = await new Promise((resolve) => execFile('ps', ['-t', tty.slice(5), '-o', 'comm='], { timeout: 3000 }, (err, out) => resolve(err ? null : out)));
  if (procs == null) return false;
  const busy = procs.split('\n').map((c) => path.basename(c.trim()).replace(/^-/, '')).filter((c) => c && !SHELLS.has(c));
  if (busy.length) return false;
  await osascript(`tell application "Terminal" to close (every window whose id is ${id})`);
  return true;
}

const TRUST = /trust this folder|directory you created or one you trust|Do you trust/i;
const YES = /^\s*(❯\s*)?(\d\.\s*)?Yes\b/;
const as = (s) => `"${String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const tail = (s) => String(s ?? '').replace(/\s+$/, '').split('\n').filter((l) => l.trim()).slice(-15).join('\n');
