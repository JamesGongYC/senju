// The session viewer, shared by the desktop launcher and the web control page.
//
// A session reads top to bottom like a chat, one block per turn:
//   your message → a timeline with one column per agent (the lead first), time running down and shared
//   by every column → the turn's summary. A column opens into that agent's trace when its head is clicked.
// A worker card lists its steps the way Claude Code lists tool calls: "● click  Sign in", with the
// result underneath when it is available (personal sessions only; team history never stores results).
//
//   const view = createTraceView(el, { showResults: true });
//   view.load(session, rows);     // session: { title, turns: [{goal, ownerName, started, ended, status, summary, usage}] }
//   view.push(row);               // rows: { turn, at, event } — live events as they happen
//
// No dependencies, no innerHTML: every string from a session is set as text.

const LOOK = /(^|_)(snapshot|screenshot|get_window_state|list_windows|get_browser_state|evaluate|read|state|wait_for|wait)$/;
const LEAD_HIDDEN = new Set(['wait', 'board_read', 'read_skill', 'ask_user']);

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; };
const add = (parent, tag, cls, text) => parent.appendChild(el(tag, cls, text));
const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));
function dur(a, b) {
  const s = Math.max(0, Math.round((ms(b) - ms(a)) / 1000));
  if (!Number.isFinite(s)) return '';
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
const clock = (t) => { const d = new Date(ms(t)); return Number.isNaN(+d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
const fmtTokens = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0);

// "browser_james-mac__browser_click" → { verb: 'click', server: 'browser' }
export function toolParts(name) {
  const full = String(name ?? '');
  const i = full.lastIndexOf('__');
  const server = i > 0 ? full.slice(0, i).split(/[_@]/)[0] : '';
  const verb = (i > 0 ? full.slice(i + 2) : full).replace(/^browser_/, '').replace(/_/g, ' ');
  return { verb, server };
}

function newTurn(index, meta = {}) {
  return {
    index, goal: meta.goal ?? '', by: meta.ownerName ?? null, started: meta.started ?? null, ended: meta.ended ?? null,
    status: meta.status ?? null, summary: meta.summary ?? null, usage: meta.usage ?? null, costMicro: meta.costMicro ?? null,
    flow: [],            // in time order: { kind: 'lead'|'said'|'agent'|'board'|'memo'|'ask'|'error', ... }
    agents: new Map(),   // id -> worker
    leadSteps: [],
    first: null, last: null,
  };
}

export function createTraceView(root, { showResults = false } = {}) {
  root.classList.add('tv');
  const state = { session: null, turns: [], showResults, filter: 'all', open: new Set(), raf: 0, dirty: new Set() };
  const turnsEl = el('div', 'tv-turns');
  const bar = el('div', 'tv-bar');
  root.replaceChildren(bar, turnsEl);

  function turnAt(i) {
    while (state.turns.length <= i) state.turns.push(newTurn(state.turns.length, state.session?.turns?.[state.turns.length]));
    return state.turns[i];
  }

  function apply(row) {
    const t = turnAt(row.turn ?? 0);
    const e = row.event;
    const at = e.at ?? row.at ?? Date.now();
    t.first ??= at;
    t.last = at;
    const agent = (id) => t.agents.get(id);
    switch (e.type) {
      case 'session':
        t.goal ||= e.goal ?? '';
        t.by ||= e.owner?.name ?? null;
        t.started ||= row.at;
        break;
      case 'said':
        t.flow.push({ kind: 'said', at, name: e.from?.name ?? 'You', text: e.text, target: e.target });
        break;
      case 'spawn': {
        const a = { id: e.agent.id, name: e.agent.name, color: e.agent.color ?? '#888', goal: e.agent.goal ?? '', dependsOn: e.agent.dependsOn ?? [], status: 'starting', label: '', deviceName: null, steps: [], report: null, first: at, last: at };
        t.agents.set(a.id, a);
        t.flow.push({ kind: 'agent', at, id: a.id });
        break;
      }
      case 'agent': {
        const a = agent(e.id);
        if (!a) break;
        a.status = e.status ?? a.status;
        a.label = e.label ?? a.label;
        if (e.deviceName) a.deviceName = e.deviceName;
        a.last = at;
        break;
      }
      case 'step': {
        if (e.agentId === 'lead') {
          const parts = toolParts(e.tool);
          if (e.kind === 'say') t.flow.push({ kind: 'lead', at, text: e.text });
          else if (!LEAD_HIDDEN.has(parts.verb.replace(/ /g, '_')) && e.tool !== 'spawn_agent') t.flow.push({ kind: 'leadtool', at, tool: e.tool, label: e.label });
          t.leadSteps.push(at);
          break;
        }
        const a = agent(e.agentId);
        if (!a) break;
        a.steps.push({ ...e, at });
        if (e.deviceName) a.deviceName = e.deviceName;
        a.last = at;
        break;
      }
      case 'chat':
        if (e.from === 'lead') {
          const lastLead = [...t.flow].reverse().find((f) => f.kind === 'lead');
          if (!lastLead || lastLead.text !== e.text) t.flow.push({ kind: 'lead', at, text: e.text });
        } else {
          const a = agent(e.from);
          if (a) a.steps.push({ kind: 'reply', text: e.text, at });
        }
        break;
      case 'ask': {
        const item = { kind: 'ask', at, qid: e.qid, ask: e, answer: null, agentId: e.agentId };
        const a = agent(e.agentId);
        if (a) a.steps.push(item); else t.flow.push(item);
        break;
      }
      case 'answered': {
        const all = [...t.flow, ...[...t.agents.values()].flatMap((a) => a.steps)];
        const item = all.find((s) => s.kind === 'ask' && s.qid === e.qid);
        if (item) item.answer = { text: e.text ?? null, by: e.by ?? null, at };
        break;
      }
      case 'result': { const a = agent(e.id); if (a) { a.report = e.text; a.last = at; } break; }
      case 'board': t.flow.push({ kind: 'board', at, from: e.from, text: e.note }); break;
      case 'remembered': t.flow.push({ kind: 'memo', at, text: `Remembered${e.person ? ` for ${e.scope === 'team' ? 'the team' : e.person}` : ''}: ${e.note}` }); break;
      case 'skill': t.flow.push({ kind: 'memo', at, text: `${e.created ? 'Learned a new skill' : 'Improved a skill'}: ${e.name}${e.revision > 1 ? ` (revision ${e.revision})` : ''}` }); break;
      case 'done': t.summary = e.summary; t.status = 'done'; t.ended ||= at; break;
      case 'error': t.flow.push({ kind: 'error', at, text: e.message }); t.status ||= 'stopped'; t.ended ||= at; break;
      case 'state': if (e.state === 'idle') t.ended ||= at; if (e.state === 'running' || e.state === 'planning') t.status = t.status === 'done' ? t.status : 'running'; break;
      default: break;
    }
    return t.index;
  }

  // ---- Rendering ----

  function stepRow(s, a) {
    if (s.kind === 'say') return el('p', 'tv-say', s.text);
    if (s.kind === 'reply') { const p = el('p', 'tv-say tv-reply'); add(p, 'b', null, 'Replied: '); p.append(s.text); return p; }
    if (s.kind === 'ask') return askBox(s);
    const { verb } = toolParts(s.tool);
    const row = el('div', `tv-step${s.isError ? ' err' : ''}${LOOK.test(verb.replace(/ /g, '_')) ? ' look' : ''}`);
    const head = add(row, 'div', 'tv-step-head');
    const dot = add(head, 'i', 'tv-dot');
    dot.style.background = s.isError ? 'var(--danger)' : a?.color ?? 'var(--ink)';
    add(head, 'span', 'tv-verb', verb);
    if (s.label) add(head, 'span', 'tv-label', s.label);
    if (s.ms > 1500) add(head, 'span', 'tv-ms', dur(0, s.ms));
    if (state.showResults && s.result) {
      const res = add(row, 'div', 'tv-result');
      add(res, 'span', 'tv-elbow', '⎿');
      const body = add(res, 'span', 'tv-result-text', s.result);
      res.addEventListener('click', () => body.classList.toggle('full'));
    }
    return row;
  }

  // Runs of look-only steps (snapshots, window reads) fold into one quiet line.
  function stepList(steps, a) {
    const out = [];
    let looks = [];
    const flush = () => {
      if (looks.length === 1) out.push(stepRow(looks[0], a));
      else if (looks.length > 1) { const n = el('div', 'tv-step look folded'); const h = add(n, 'div', 'tv-step-head'); add(h, 'i', 'tv-dot').style.background = 'var(--line-strong)'; add(h, 'span', 'tv-verb', `looked ${looks.length}×`); out.push(n); }
      looks = [];
    };
    for (const s of steps) {
      const quiet = s.kind === 'tool' && !s.isError && LOOK.test(toolParts(s.tool).verb.replace(/ /g, '_')) && !(state.showResults);
      if (quiet) { looks.push(s); continue; }
      flush();
      out.push(stepRow(s, a));
    }
    flush();
    return out;
  }

  function askBox(item) {
    const box = el('div', 'tv-ask');
    const e = item.ask;
    const kind = e.kind === 'question' ? 'Asked' : e.kind === 'task' ? 'Asked you to do' : 'Needed you to';
    add(box, 'div', 'tv-ask-kind', e.redacted ? `Needed ${e.audience?.userName ?? 'someone'} at their computer` : kind);
    if (!e.redacted) add(box, 'div', 'tv-ask-text', e.question ?? e.task ?? e.reason ?? '');
    if (item.answer) {
      const ans = add(box, 'div', 'tv-ask-answer');
      add(ans, 'b', null, item.answer.by ? `${item.answer.by}: ` : 'Answer: ');
      ans.append(item.answer.text ?? 'answered');
    } else add(box, 'div', 'tv-ask-answer dim', 'waiting for an answer');
    return box;
  }

  // ---- The timeline: agents across, time down ----
  // Every agent is a column. Closed, a column is a lifeline with a dot per step; opened (click its head),
  // it shows the agent's trace. Rows are shared by all columns, so things that happened at the same time
  // sit side by side.

  const LIVE = ['acting', 'thinking', 'starting', 'waiting', 'blocked', 'paused'];
  const isLive = (t, a) => LIVE.includes(a.status) && t.status === 'running';
  const statusWord = (t, a) => {
    if (a.status === 'done') return 'done';
    if (a.status === 'error') return 'error';
    if (a.status === 'cancelled') return 'stopped';
    if (!isLive(t, a)) return a.status;
    if (a.status === 'waiting') return 'needs you';
    if (a.status === 'paused' && a.label === 'waiting while you type') return 'holding';
    return a.status;
  };
  const isOpen = (t, key, dflt) => state.open.has(`${t.index}:${key}`) || (dflt && !state.open.has(`${t.index}:${key}:closed`));
  function toggle(t, key, open) {
    const k = `${t.index}:${key}`;
    if (open) { state.open.delete(k); state.open.add(`${k}:closed`); } else { state.open.add(k); state.open.delete(`${k}:closed`); }
    draw(t.index);
  }

  // What a worker's column shows, in time order. Runs of look-only steps fold into one line.
  function workerItems(t, a) {
    const items = [{ kind: 'start', at: a.first }];
    let looks = null;
    for (const st of a.steps) {
      const quiet = st.kind === 'tool' && !st.isError && LOOK.test(toolParts(st.tool).verb.replace(/ /g, '_')) && !state.showResults;
      if (quiet) { if (looks) looks.n++; else items.push(looks = { kind: 'looks', at: st.at, n: 1, s: st }); continue; }
      looks = null;
      items.push({ kind: 'step', at: st.at, s: st });
    }
    if (a.report) items.push({ kind: 'report', at: a.last });
    else if (isLive(t, a) && a.label) items.push({ kind: 'now', at: a.last });
    return items;
  }

  function leadItems(t) {
    return t.flow
      .filter((f) => !(f.kind === 'lead' && t.summary && f.text.trim() === String(t.summary).trim()))   // the final reply is the summary below
      .map((f) => ({ kind: `lead-${f.kind}`, at: f.at, f }));
  }

  function cell(t, a, it) {
    switch (it.kind) {
      case 'start': { const c = el('div', 'tl-item tl-start'); add(c, 'span', 'tl-kicker', 'Started'); add(c, 'p', null, a.goal); c.title = 'Click to read the whole goal'; c.addEventListener('click', () => c.classList.toggle('full')); return c; }
      case 'looks': {
        if (it.n === 1) return stepRow(it.s, a);
        const c = el('div', 'tv-step look folded');
        const h = add(c, 'div', 'tv-step-head');
        add(h, 'i', 'tv-dot').style.background = 'var(--line-strong)';
        add(h, 'span', 'tv-verb', `looked ${it.n}×`);
        return c;
      }
      case 'step': return stepRow(it.s, a);
      case 'report': { const q = el('blockquote', 'tv-report'); add(q, 'b', null, 'Report'); add(q, 'p', null, a.report); return q; }
      case 'now': return el('div', 'tv-now', a.label);
      case 'lead-lead': { const c = el('div', 'tl-item tl-leadsay'); add(c, 'p', null, it.f.text); return c; }
      case 'lead-leadtool': { const { verb } = toolParts(it.f.tool); const c = el('div', 'tv-leadtool'); add(c, 'span', 'tv-verb', verb); if (it.f.label) add(c, 'span', 'tv-label', it.f.label); return c; }
      case 'lead-said': {
        const f = it.f;
        const c = el('div', 'tv-said');
        add(c, 'b', null, `${f.name}${f.target && f.target !== 'lead' ? ` → ${t.agents.get(f.target)?.name ?? 'a worker'}` : ''}: `);
        c.append(f.text);
        return c;
      }
      case 'lead-agent': {
        const w = t.agents.get(it.f.id);
        const c = el('button', 'tl-spawn');
        c.style.setProperty('--agent', w?.color ?? '#888');
        add(c, 'i', 'tv-dot');
        c.append(`started ${w?.name ?? 'a worker'}`);
        c.addEventListener('click', () => w && toggle(t, w.id, isOpen(t, w.id, isLive(t, w))));
        return c;
      }
      case 'lead-board': { const c = el('div', 'tv-board'); add(c, 'b', null, `${it.f.from} on the board: `); c.append(it.f.text); return c; }
      case 'lead-memo': return el('div', 'tv-memo', it.f.text);
      case 'lead-ask': return askBox(it.f);
      case 'lead-error': return el('div', 'tv-error', it.f.text);
      default: return el('div');
    }
  }

  function timeline(t) {
    const workers = [...t.agents.values()];
    const cols = [
      { key: 'lead', name: 'Lead', color: 'var(--ink)', lead: true, open: isOpen(t, 'lead', true), items: leadItems(t), live: t.status === 'running', word: t.status === 'running' ? 'running' : 'done', count: t.leadSteps.length },
      ...workers.map((a) => ({ key: a.id, a, name: a.name, color: a.color, open: isOpen(t, a.id, isLive(t, a)), items: workerItems(t, a), live: isLive(t, a), word: statusWord(t, a), count: a.steps.filter((x) => x.kind === 'tool').length, device: a.deviceName })),
    ];
    if (!workers.length && !cols[0].items.length) return null;

    // Shared rows: everything an open column shows, plus where each closed column starts and ends.
    // Things from different columns within two seconds of each other share a row.
    const evs = [];
    cols.forEach((c, ci) => {
      // A closed column also marks each half minute it was busy, so its lifeline keeps its length in time.
      let shown = c.items;
      if (!c.open && c.items.length > 1) {
        const seen = new Set();
        shown = [c.items[0], ...c.items.slice(1, -1).filter((it) => { const b = Math.floor(ms(it.at) / 30000); if (seen.has(b)) return false; seen.add(b); return true; }), c.items.at(-1)];
      }
      shown.forEach((it, k) => evs.push({ ci, it, time: ms(it.at) || 0, order: k }));
    });
    evs.sort((x, y) => x.time - y.time || x.ci - y.ci || x.order - y.order);
    const rows = [];
    for (const ev of evs) {
      const r = rows.at(-1);
      if (r && !r.used.has(ev.ci) && ev.time - r.time <= 2000) { r.used.add(ev.ci); r.evs.push(ev); }
      else rows.push({ time: ev.time, used: new Set([ev.ci]), evs: [ev] });
    }
    // The last row at or before a time.
    const rowAt = (time) => {
      let lo = 0, hi = rows.length - 1, best = 0;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].time <= time) { best = mid; lo = mid + 1; } else hi = mid - 1; }
      return best;
    };
    const t0 = ms(t.started ?? t.first) || rows[0]?.time || 0;

    const wrap = el('div', 'tl-wrap');
    const grid = add(wrap, 'div', 'tl-grid');
    grid.style.gridTemplateColumns = `52px ${cols.map((c) => c.open ? (c.lead ? 'minmax(300px, 1.3fr)' : 'minmax(280px, 1fr)') : '132px').join(' ')}`;
    const place = (node, row, col, rowEnd) => {
      node.style.gridRow = rowEnd ? `${row} / ${rowEnd}` : String(row);
      node.style.gridColumn = String(col);
      grid.append(node);
      return node;
    };

    // Zebra bands first, so everything else sits on top.
    rows.forEach((r, ri) => { if (ri % 2 === 1) { const b = place(el('div', 'tl-band'), ri + 2, 1); b.style.gridColumn = `1 / ${cols.length + 2}`; } });

    // Heads, across the top.
    place(el('div', 'tl-corner', 'time'), 1, 1);
    cols.forEach((c, ci) => {
      const head = el('button', `tl-head${c.open ? ' open' : ''}${c.live ? ' live' : ''}${c.lead ? ' lead' : ''}`);
      head.style.setProperty('--agent', c.color);
      head.title = c.open ? 'Fold this trace' : 'Open this trace';
      const top = add(head, 'span', 'tl-head-top');
      add(top, 'i', 'tl-orb');
      add(top, 'b', null, c.name);
      add(top, 'span', 'tl-chev', c.open ? '▾' : '▸');
      const meta = add(head, 'span', 'tl-head-meta');
      add(meta, 'span', `pill ${c.live ? 'live' : c.word}`, c.word);
      add(meta, 'span', 'tv-count', `${c.count} step${c.count === 1 ? '' : 's'}`);
      if (c.device) add(head, 'span', 'tl-device', `on ${c.device}`);
      head.addEventListener('click', () => toggle(t, c.key, c.open));
      place(head, 1, ci + 2);
    });

    // Time down the left, from the start of the turn.
    let lastLabel = '';
    rows.forEach((r, ri) => {
      const sec = Math.max(0, Math.round((r.time - t0) / 1000));
      const label = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      place(el('div', `tl-time${label === lastLabel ? ' same' : ''}`, label), ri + 2, 1);
      lastLabel = label;
    });

    // Each column: its lifeline, then dots (closed) or its trace (open).
    cols.forEach((c, ci) => {
      const mine = rows.map((r, ri) => (r.used.has(ci) ? ri : -1)).filter((ri) => ri >= 0);
      if (!mine.length) return;
      const life = place(el('div', `tl-life${c.live ? ' live' : ''}${c.open ? ' open' : ''}`), mine[0] + 2, ci + 2, mine.at(-1) + 3);
      life.style.setProperty('--agent', c.color);
      if (!c.open) {
        // A dot in the row where each step happened, bigger when several fall in one row.
        const per = new Map();
        for (const st of c.lead ? c.items : c.a.steps) {
          const ri = rowAt(ms(st.at));
          const m = per.get(ri) ?? { n: 0, err: false, ask: false };
          m.n++;
          m.err ||= Boolean(st.isError ?? st.s?.isError);
          m.ask ||= st.kind === 'ask' || st.kind === 'lead-ask';
          per.set(ri, m);
        }
        for (const [ri, m] of per) {
          const dot = place(el('button', 'tl-dotcell'), ri + 2, ci + 2);
          dot.title = `${m.n} step${m.n === 1 ? '' : 's'}: click to open`;
          const d = add(dot, 'i', `tl-pip${m.err ? ' err' : ''}${m.ask ? ' ask' : ''}`);
          d.style.setProperty('--agent', c.color);
          d.style.setProperty('--size', `${Math.min(18, 7 + Math.sqrt(m.n) * 2.4)}px`);
          dot.addEventListener('click', () => toggle(t, c.key, false));
        }
        return;
      }
      rows.forEach((r, ri) => {
        for (const ev of r.evs) {
          if (ev.ci !== ci) continue;
          const box = place(el('div', 'tl-cell'), ri + 2, ci + 2);
          box.style.setProperty('--agent', c.color);
          box.append(cell(t, c.a, ev.it));
        }
      });
    });
    return wrap;
  }

  function drawTurn(t) {
    const sec = el('article', 'tv-turn');
    sec.dataset.turn = t.index;
    const you = add(sec, 'div', 'tv-you');
    const bubble = add(you, 'div', 'tv-bubble');
    add(bubble, 'p', null, t.goal || '(no message)');
    add(you, 'div', 'tv-you-meta', `${t.by ?? 'You'}${t.started ? ` · ${clock(t.started)}` : ''}${t.index > 0 ? ' · continued' : ''}`);
    const tl = timeline(t);
    if (tl) sec.append(tl);
    if (t.summary || t.status === 'stopped') {
      const done = add(sec, 'div', `tv-summary ${t.status === 'done' ? '' : 'stopped'}`);
      add(done, 'div', 'tv-summary-kicker', t.status === 'done' ? 'Done' : 'Stopped');
      add(done, 'p', null, t.summary ?? 'This turn ended before it finished.');
      const facts = [];
      if (t.first && t.ended) facts.push(dur(t.started ?? t.first, t.ended));
      if (t.agents.size) facts.push(`${t.agents.size} worker${t.agents.size === 1 ? '' : 's'}`);
      const u = t.usage;
      if (u) facts.push(`${fmtTokens((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0))} tokens`);
      if (t.costMicro) facts.push(`$${(t.costMicro / 1e6).toFixed(2)}`);
      if (facts.length) add(done, 'div', 'tv-summary-facts', facts.join(' · '));
    } else if (t.status === 'running') {
      add(sec, 'div', 'tv-working', 'Working…');
    }
    return sec;
  }

  function drawBar() {
    bar.replaceChildren();
    add(bar, 'div', 'tv-hint', 'Click an agent to open its trace. Rows line up in time across agents.');
    const tools = add(bar, 'div', 'tv-tools');
    if (state.canShowResults) {
      const lab = add(tools, 'label', 'tv-toggle');
      const box = add(lab, 'input');
      box.type = 'checkbox';
      box.checked = state.showResults;
      box.addEventListener('change', () => { state.showResults = box.checked; drawAll(); });
      lab.append('Tool results');
    }
    const all = add(tools, 'button', 'tv-filter', state.expandAll ? 'Collapse all' : 'Expand all');
    all.addEventListener('click', () => {
      state.expandAll = !state.expandAll;
      for (const t of state.turns) for (const a of [{ id: 'lead' }, ...t.agents.values()]) { const k = `${t.index}:${a.id}`; if (state.expandAll) { state.open.add(k); state.open.delete(`${k}:closed`); } else { state.open.delete(k); state.open.add(`${k}:closed`); } }
      drawAll();
    });
  }

  function drawAll() {
    drawBar();
    turnsEl.replaceChildren(...state.turns.map(drawTurn));
    if (!state.turns.length) add(turnsEl, 'div', 'tv-empty', 'Nothing here yet.');
  }

  function draw(i) {
    const old = turnsEl.querySelector(`[data-turn="${i}"]`);
    const fresh = drawTurn(state.turns[i]);
    if (old) old.replaceWith(fresh); else turnsEl.append(fresh);
  }

  const nearBottom = () => { const s = root.closest('.tv-scroll') ?? root; return s.scrollHeight - s.scrollTop - s.clientHeight < 140; };

  return {
    load(session, rows = [], opts = {}) {
      state.session = session;
      state.turns = [];
      state.open.clear();
      state.canShowResults = opts.canShowResults ?? state.showResults;
      for (let i = 0; i < (session?.turns?.length ?? 0); i++) turnAt(i);
      for (const r of rows) apply(r);
      // Facts from the saved turn win over what events implied.
      session?.turns?.forEach((meta, i) => Object.assign(state.turns[i], Object.fromEntries(Object.entries({ goal: meta.goal, by: meta.ownerName, started: meta.started, ended: meta.ended, status: meta.status === 'running' ? 'running' : meta.status, summary: meta.summary, usage: meta.usage, costMicro: meta.costMicro }).filter(([, v]) => v != null))));
      drawAll();
    },
    push(row) {
      const stick = nearBottom();
      const i = apply(row);
      state.dirty.add(i);
      if (state.raf) return;
      state.raf = requestAnimationFrame(() => {
        state.raf = 0;
        const newAgent = row.event.type === 'spawn';
        if (newAgent) drawBar();
        for (const d of state.dirty) draw(d);
        state.dirty.clear();
        if (stick) { const s = root.closest('.tv-scroll') ?? root; s.scrollTop = s.scrollHeight; }
      });
    },
    // A new turn is about to start (the person sent a message): show it straight away.
    startTurn(goal, by) {
      const t = turnAt(state.turns.length);
      Object.assign(t, { goal, by, started: new Date().toISOString(), status: 'running' });
      draw(t.index);
      return t.index;
    },
    get turnCount() { return state.turns.length; },
  };
}
