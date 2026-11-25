// The launcher window: choose how to work, then a chat-like home of sessions, plus skills and memory.
// Talks to the main process through window.senju (src/launcher-preload.cjs).
import { createTraceView } from '../web/shared/trace-view.js';
import { h, sticker, scribbleArrow } from '../web/shared/brand.js';
import { renderLibrary } from '../web/shared/library-view.js';

const $app = document.getElementById('app');
const senju = window.senju;

async function call(name, ...args) {
  const res = await senju[name](...args);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

// ---- State ----
const app = {
  s: null,                 // the main process's state (mode, account, running…)
  view: 'loading',         // choose | key | signin | home
  panel: 'new',            // new | session | library | models
  selected: null,          // session id
  sessions: [],
  detail: null,            // the selected session's meta
  tv: null,                // the trace view on screen
  libTab: 'skills',
  error: '',
};

async function refreshState() { app.s = await call('state'); return app.s; }

async function boot() {
  await refreshState();
  if (!app.s.mode && app.s.fixedMode) await call('chooseMode', app.s.fixedMode).then((s) => { app.s = s; });
  route();
}

// Where to go from the current state.
function route() {
  const s = app.s;
  if (!s.mode) app.view = 'choose';
  else if (!s.team && !s.hasKey) app.view = 'key';
  else if (s.team && s.account?.state !== 'signed_in') app.view = 'signin';
  else app.view = 'home';
  render();
  if (app.view === 'home') loadSessions();
}

function render() {
  document.body.dataset.view = app.view;
  if (app.view === 'loading') return $app.replaceChildren();
  if (app.view === 'choose') return $app.replaceChildren(chooseScreen());
  if (app.view === 'key') return $app.replaceChildren(keyScreen());
  if (app.view === 'signin') return $app.replaceChildren(signinScreen());
  return $app.replaceChildren(homeScreen());
}

// ---- The first screen: personal or team ----
function chooseScreen() {
  const pick = async (mode) => {
    try { app.s = await call('chooseMode', mode); route(); } catch (err) { app.error = err.message; render(); }
  };
  const card = (mode, kicker, title, lines, cta) => h('button', { class: `choice${app.s.lastMode === mode ? ' last' : ''}`, onclick: () => pick(mode) },
    h('span', { class: 'choice-kicker' }, kicker),
    h('span', { class: 'choice-title' }, title),
    h('ul', {}, lines.map((l) => h('li', {}, l))),
    h('span', { class: 'btn btn-punk' }, cta, ' →'));
  return h('main', { class: 'stage choose' },
    h('header', { class: 'top drag' }, h('span', { class: 'logo display' }, 'Senju'), h('span', { class: 'top-pills' }, h('button', { class: 'btn btn-outline-white btn-sm nodrag', onclick: () => call('openWeb') }, 'Team web page ↗'))),
    h('section', { class: 'hero' },
      h('h1', { class: 'display hero-title' }, h('span', { class: 'hash' }, '#'), 'Swarm', h('br'), 'your', h('br'), 'screen'),
      sticker(), scribbleArrow()),
    h('section', { class: 'choices' },
      card('local', 'Local', 'This Mac only', ['Your own API key', 'Nothing leaves this Mac', 'Agents use your apps and browser'], 'Start local'),
      card('cloud', 'Cloud', 'Your orgs', ['Your personal org, and every team you are in', 'Sessions, skills and memory kept per org', 'Agents can work across teammates’ Macs'], app.s.demo ? 'Not in demo' : 'Sign in')),
    app.error ? h('p', { class: 'stage-error' }, app.error) : null,
    h('p', { class: 'stage-foot' }, 'You can switch any time from the ◎ menu bar icon.'));
}

// Local without keys for the chosen models: choose the models, then add the keys they need.
function keyScreen() {
  return h('main', { class: 'stage centered' },
    h('header', { class: 'top drag' }, h('span', { class: 'logo display' }, 'Senju')),
    h('div', { class: 'panel-card wide' },
      h('div', { class: 'choice-kicker' }, 'Local'),
      h('h2', { class: 'display card-title' }, 'Models & keys'),
      h('p', { class: 'dim' }, 'Local sessions run on your own API keys. They are stored encrypted in this Mac’s keychain and never leave it.'),
      modelsForm({ firstRun: true }),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-ghost', onclick: () => back() }, '← Back'))));
}

// The models the lead and the workers run on, and an API key per provider. Used on the key screen and in the
// "Models & keys" panel.
function modelsForm({ firstRun = false } = {}) {
  const m = app.s.models;
  const box = h('div', { class: 'models' });
  if (!m) return box;
  const err = h('p', { class: 'error-text' });
  const list = h('datalist', { id: 'model-suggestions' }, m.suggestions.map((v) => h('option', { value: v })));
  const plain = (k) => (k?.startsWith('anthropic:') ? k.slice(10) : k);
  const field = (info) => h('input', { class: 'field', list: 'model-suggestions', value: plain(info.key) ?? '', spellcheck: false });
  const lead = field(m.lead), worker = field(m.worker);
  const about = (info) => (info.error ? h('span', { class: 'error-text small' }, info.error)
    : h('span', { class: 'dim small' }, [info.label, info.vision ? 'sees images' : 'text only', `${Math.round(info.context / 1000)}K context`, info.price ? `$${info.price.input}/$${info.price.output} per M tokens` : null].filter(Boolean).join(' · ')));
  const saveModels = async () => {
    err.textContent = '';
    try { app.s = await call('setModels', { lead: lead.value, worker: worker.value }); if (firstRun) route(); else render(); } catch (e) { err.textContent = e.message; }
  };
  const needed = new Set([m.lead.provider, m.worker.provider].filter(Boolean));
  const keyRow = (p) => {
    const input = h('input', { class: 'field', type: 'password', placeholder: p.hint, autocomplete: 'off' });
    const save = async () => {
      err.textContent = '';
      try { app.s = await call('saveKey', input.value, p.id); if (firstRun && app.s.hasKey) route(); else render(); } catch (e) { err.textContent = e.message; }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    const status = !p.needsKey ? 'no key needed' : p.hasKey ? 'saved' : needed.has(p.id) ? 'needed for your models' : 'not set';
    const forget = async () => { app.s = await call('forgetKey', p.id); render(); };
    // OpenRouter: sign in there and approve, instead of copying a key. The browser opens; this waits for the answer.
    const connect = async (btn) => {
      err.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Waiting for OpenRouter…';
      try { app.s = await call('connectOpenRouter'); if (firstRun && app.s.hasKey) route(); else render(); } catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Connect OpenRouter'; }
    };
    const limitLink = p.limits && p.needsKey ? h('button', { class: 'link small', onclick: () => call('openUrl', p.limits) }, 'Set a spending limit ↗') : null;
    return h('div', { class: `key-row${needed.has(p.id) && !p.hasKey ? ' need' : ''}` },
      h('div', { class: 'key-name' }, h('b', {}, p.label), h('span', { class: 'dim small' }, status), limitLink),
      p.needsKey && p.savable
        ? (p.hasKey ? h('button', { class: 'link', onclick: forget }, 'Remove')
          : h('div', { class: 'key-input' },
            p.connect ? h('button', { class: 'btn btn-punk btn-sm', onclick: (ev) => connect(ev.currentTarget) }, 'Connect OpenRouter') : null,
            p.connect ? h('span', { class: 'dim small' }, 'or') : null,
            input, h('button', { class: `btn ${p.connect ? 'btn-ghost' : 'btn-punk'} btn-sm`, onclick: save }, 'Save')))
        : null);
  };
  // Keys matter only for Local: Cloud sessions use the keys saved on the web page.
  const shown = m.providers.filter((p) => needed.has(p.id) || (p.needsKey && p.hasKey) || ['anthropic', 'openrouter'].includes(p.id));
  box.append(list,
    h('label', { class: 'model-field' }, h('span', { class: 'kicker' }, 'Lead (plans and talks to you)'), lead, about(m.lead)),
    h('label', { class: 'model-field' }, h('span', { class: 'kicker' }, 'Workers (do the steps)'), worker, about(m.worker)),
    h('div', { class: 'row left' }, h('button', { class: 'btn btn-punk btn-sm', onclick: saveModels }, 'Use these models')),
    h('p', { class: 'dim small' }, 'A Claude id (claude-sonnet-5-5) or provider:model, for example openrouter:ricursiveai/ripple-65b-preview.'),
    app.s.team
      ? h('p', { class: 'dim small' }, 'Cloud sessions run on the API keys saved on the web page (Billing). Add a key there for each provider your models use.')
      : h('div', { class: 'keys' }, h('span', { class: 'kicker' }, 'API keys'),
        h('p', { class: 'dim small' }, 'Jobs are billed to these keys. Set a spending limit on each with its provider, so a long job cannot run up an open-ended bill. Connect OpenRouter suggests a $20 limit, which you can change on its page.'),
        shown.map(keyRow)),
    err);
  return box;
}

function signinScreen() {
  const acct = app.s.account;
  const email = h('input', { class: 'field', type: 'email', placeholder: 'you@example.com', autocomplete: 'username' });
  const pass = h('input', { class: 'field', type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const err = h('p', { class: 'error-text' }, acct?.error ?? '');
  const go = async () => {
    err.textContent = '';
    try { await call('signIn', email.value, pass.value); } catch (e) { err.textContent = e.message; }
  };
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  let body;
  if (acct?.state === 'no_team') {
    body = [h('h2', { class: 'display card-title' }, 'No org yet'), h('p', { class: 'dim' }, 'Your account has no org yet. Open the web page once to set it up, then come back.'),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-ghost', onclick: () => call('signOut') }, 'Sign out'), h('button', { class: 'btn btn-punk', onclick: () => call('openWeb') }, 'Open the web page ↗'))];
  } else if (!acct || acct.state === 'offline') {
    body = [h('h2', { class: 'display card-title' }, 'Connecting'), h('p', { class: 'dim' }, acct?.error ?? 'Reaching your team server…')];
  } else {
    body = [h('h2', { class: 'display card-title' }, 'Sign in'), h('p', { class: 'dim' }, 'One account for your personal org and every team you are in.'), email, pass, err,
      h('div', { class: 'row' }, h('button', { class: 'btn btn-ghost', onclick: () => call('openWeb') }, 'Create an account ↗'), h('button', { class: 'btn btn-punk', onclick: go }, 'Sign in'))];
  }
  return h('main', { class: 'stage centered' },
    h('header', { class: 'top drag' }, h('span', { class: 'logo display' }, 'Senju')),
    h('div', { class: 'panel-card' }, h('div', { class: 'choice-kicker' }, 'Cloud'), ...body, h('button', { class: 'link', onclick: back }, '← Work locally instead')));
}

// Back to the first screen. Nothing changes until another way of working is picked there.
function back() {
  app.view = 'choose';
  render();
}

// ---- Home: sessions on the left, the chosen one (or a new one, or the library) on the right ----
async function loadSessions() {
  try { app.sessions = await call('sessions'); } catch (err) { app.sessions = []; app.error = err.message; }
  const side = document.querySelector('.side-list');
  if (side) side.replaceWith(sessionList());
}

function groupOf(iso) {
  const d = new Date(iso), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff < 7 ? 'This week' : 'Earlier';
}

function sessionList() {
  const groups = new Map();
  for (const s of app.sessions) {
    const g = groupOf(s.updatedAt ?? s.startedAt);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const list = h('nav', { class: 'side-list' });
  if (!app.sessions.length) list.append(h('p', { class: 'side-empty' }, 'Your sessions will show up here.'));
  for (const [g, rows] of groups) {
    list.append(h('div', { class: 'side-group' }, g));
    for (const s of rows) {
      list.append(h('button', { class: `side-item${app.selected === s.id && app.panel === 'session' ? ' on' : ''}`, onclick: () => openSession(s.id) },
        h('span', { class: 'side-title' }, s.title || 'Untitled'),
        h('span', { class: 'side-meta' }, s.live ? h('span', { class: 'pill live' }, 'live') : `${s.turnCount} turn${s.turnCount === 1 ? '' : 's'}`)));
    }
  }
  return list;
}

function homeScreen() {
  const s = app.s;
  const side = h('aside', { class: 'side stage' },
    h('div', { class: 'side-top drag' }),
    h('div', { class: 'side-brand' }, h('span', { class: 'logo display' }, 'Senju'), s.team ? null : h('span', { class: 'side-mode' }, 'Local')),
    s.team ? orgSwitcher() : null,
    h('button', { class: 'btn btn-punk side-new', onclick: () => { app.panel = 'new'; app.selected = null; render(); } }, '+ New session'),
    sessionList(),
    h('div', { class: 'side-bottom' },
      h('button', { class: `side-link${app.panel === 'library' ? ' on' : ''}`, onclick: () => { app.panel = 'library'; render(); } }, 'Skills & memory'),
      h('button', { class: `side-link${app.panel === 'models' ? ' on' : ''}`, onclick: () => { app.panel = 'models'; render(); } }, 'Models & keys'),
      s.team ? h('button', { class: 'side-link', onclick: () => call('openWeb') }, 'Manage orgs on the web ↗') : null,
      h('div', { class: 'side-account' },
        h('span', {}, s.team ? (s.account?.user?.name ?? '') : 'On this Mac only'),
        h('button', { class: 'link light', onclick: () => switchMode() }, s.team ? 'Switch to Local' : 'Switch to Cloud'),
        s.team ? h('button', { class: 'link light', onclick: async () => { await call('signOut'); } }, 'Sign out') : null)));
  let main;
  if (app.panel === 'library') main = libraryPanel();
  else if (app.panel === 'models') main = h('section', { class: 'main models-panel' }, h('h2', { class: 'display' }, 'Models & keys'), modelsForm());
  else if (app.panel === 'session' && app.selected) main = sessionPanel();
  else main = newPanel();
  return h('div', { class: 'home' }, side, main);
}

async function switchMode() {
  try { app.s = await call('chooseMode', app.s.team ? 'local' : 'cloud'); app.panel = 'new'; app.selected = null; route(); } catch (err) { alert(err.message); }
}

// Cloud: which org this Mac is working in. Sessions, skills and memory below all belong to it.
function orgSwitcher() {
  const current = app.s.account?.team;
  const select = h('select', { class: 'org-select', title: 'Switch org' },
    h('option', { value: current?.id ?? '' }, current ? `${current.personal ? 'Personal · ' : ''}${current.name}` : 'Connecting…'));
  call('orgs').then((orgs) => {
    if (!orgs.length) return;
    select.replaceChildren(...orgs.map((o) => h('option', { value: o.id, selected: o.id === current?.id }, `${o.personal ? 'Personal · ' : ''}${o.name}`)),
      h('option', { value: '__web' }, '+ Create or join a team…'));
    select.value = current?.id ?? orgs[0].id;
  }).catch(() => {});
  select.addEventListener('change', async () => {
    const id = select.value;
    if (id === '__web') { select.value = current?.id ?? ''; return call('openWeb'); }
    if (id === current?.id) return;
    try { app.s = await call('switchOrg', id); app.selected = null; app.panel = 'new'; app.sessions = []; render(); } catch (err) { alert(err.message); select.value = current?.id ?? ''; }
  });
  return h('div', { class: 'org' }, h('span', { class: 'org-label' }, 'Org'), select);
}

function composer({ sessionId = null, placeholder }) {
  const running = app.s.running;
  const box = h('textarea', { class: 'composer-input', rows: 1, placeholder: running ? 'A job is running. Use the bar at the top of your screen to talk to it.' : placeholder, disabled: running });
  const err = h('div', { class: 'composer-error' });
  const sendIt = async () => {
    const goal = box.value.trim();
    if (!goal) return;
    err.textContent = '';
    try {
      const out = await call('send', goal, sessionId);
      box.value = '';
      if (out?.sessionId) { app.selected = out.sessionId; app.panel = 'session'; }
    } catch (e) { err.textContent = e.message; }
  };
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendIt(); } });
  box.addEventListener('input', () => { box.style.height = 'auto'; box.style.height = `${Math.min(220, box.scrollHeight)}px`; });
  return h('div', { class: 'composer' },
    h('div', { class: 'composer-box' }, box,
      running ? h('button', { class: 'btn btn-ink btn-sm', onclick: () => call('showOverlay') }, 'Show the bar')
        : h('button', { class: 'btn btn-punk btn-sm', onclick: sendIt }, sessionId ? 'Continue' : 'Start', h('span', { class: 'kbd on-punk' }, '↩'))),
    err,
    h('div', { class: 'composer-hint' }, `Agents take over the screen while they work. ${app.s.hotkey ? `${app.s.hotkey} brings Senju back.` : ''}`));
}

function newPanel() {
  return h('section', { class: 'main new' },
    h('div', { class: 'main-top drag' }),
    h('div', { class: 'new-center' },
      h('h1', { class: 'display new-title' }, 'What should', h('br'), 'the swarm do?'),
      composer({ placeholder: 'e.g. Compare AirPods Pro prices at three stores' }),
      h('div', { class: 'new-ideas' }, ['Play today’s Wordle and a game of Minesweeper', 'Summarise my unread email into a Notes page', 'Research three standing desks and compare them'].map((idea) =>
        h('button', { class: 'idea', onclick: (e) => { const t = e.currentTarget.closest('.new-center').querySelector('textarea'); t.value = idea; t.focus(); } }, idea)))));
}

async function openSession(id) {
  app.selected = id;
  app.panel = 'session';
  app.detail = null;
  render();
  try {
    const { session, events } = await call('session', id);
    if (app.selected !== id) return;
    app.detail = session;
    const head = document.querySelector('.session-head');
    if (head) head.replaceWith(sessionHead());
    app.tv.load(session, events, { canShowResults: Boolean(session.results) });
    const scroller = document.querySelector('.tv-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  } catch (err) {
    document.querySelector('.tv-host')?.replaceChildren(h('p', { class: 'error-text' }, err.message));
  }
}

function sessionHead() {
  const d = app.detail;
  const row = app.sessions.find((x) => x.id === app.selected);
  const title = d?.title ?? row?.title ?? '…';
  const live = row?.live || d?.status === 'running';
  const t = h('h2', { class: 'session-title', title: 'Double-click to rename' }, title);
  if (d?.canManage) {
    t.addEventListener('dblclick', () => {
      const input = h('input', { class: 'field rename', value: title });
      const done = async () => { const v = input.value.trim(); if (v && v !== title) { await call('rename', app.selected, v).catch(() => {}); await loadSessions(); app.detail = { ...app.detail, title: v }; } document.querySelector('.session-head')?.replaceWith(sessionHead()); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') document.querySelector('.session-head')?.replaceWith(sessionHead()); });
      input.addEventListener('blur', done);
      t.replaceWith(input);
      input.focus();
      input.select();
    });
  }
  return h('header', { class: 'session-head drag' },
    h('div', { class: 'session-head-text nodrag' }, t,
      h('div', { class: 'session-sub' }, live ? h('span', { class: 'pill live' }, 'live') : null, d ? `${d.turns?.length ?? 0} turn${d.turns?.length === 1 ? '' : 's'}` : '', d?.ownerName ? ` · started by ${d.ownerName}` : '')),
    d?.canManage ? h('div', { class: 'session-actions nodrag' }, h('button', { class: 'btn btn-danger btn-sm', onclick: async () => {
      if (!confirm('Delete this session and its history?')) return;
      try { await call('remove', app.selected); app.selected = null; app.panel = 'new'; await loadSessions(); render(); } catch (err) { alert(err.message); }
    } }, 'Delete')) : null);
}

function sessionPanel() {
  const host = h('div', { class: 'tv-host' });
  app.tv = createTraceView(host);
  const row = app.sessions.find((x) => x.id === app.selected);
  return h('section', { class: 'main session' },
    sessionHead(),
    h('div', { class: 'tv-scroll' }, h('div', { class: 'tv-wrap' }, host)),
    composer({ sessionId: app.selected, placeholder: row?.live ? '' : 'Continue this session: the lead remembers everything so far' }));
}

// ---- Skills & memory ----
function libraryPanel() {
  const panel = h('section', { class: 'main library' });
  renderLibrary(panel, {
    skills: () => call('skills'),
    saveSkill: (skill) => call('saveSkill', skill),
    deleteSkill: (name) => call('deleteSkill', name),
    notes: () => call('notes'),
    addNote: (note, scope) => call('addNote', note, scope),
    deleteNote: (id) => call('deleteNote', id),
  }, { team: app.s.team && !app.s.account?.team?.personal, local: !app.s.team, tab: app.libTab });
  return panel;
}

// ---- Live updates from the main process ----
senju.onEvent(async (msg) => {
  if (msg.kind === 'account') {
    app.s = { ...app.s, account: msg.account };
    if (['signin', 'home'].includes(app.view)) route();
  } else if (msg.kind === 'mode') {
    app.s = msg.state;
    route();
  } else if (msg.kind === 'state') {
    app.s = { ...app.s, running: msg.running };
    if (app.view === 'home') {
      const box = document.querySelector('.composer');
      if (box && app.panel !== 'library' && app.panel !== 'models') box.replaceWith(composer({ sessionId: app.panel === 'session' ? app.selected : null, placeholder: 'Continue this session: the lead remembers everything so far' }));
      loadSessions();
    }
  } else if (msg.kind === 'sessions') {
    await loadSessions();
    if (app.panel === 'session' && app.selected === msg.sessionId && !app.s.running) openSession(msg.sessionId);
  } else if (msg.kind === 'live') {
    // A new session started from the bar or elsewhere: follow it if nothing else is open.
    if (app.view === 'home' && app.panel === 'new' && msg.row.event.type === 'session') { await loadSessions(); app.selected = msg.sessionId; app.panel = 'session'; render(); return openSession(msg.sessionId); }
    if (app.panel === 'session' && app.selected === msg.sessionId && app.tv) {
      if (msg.row.event.type === 'session' && msg.row.turn >= app.tv.turnCount) app.tv.startTurn(msg.row.event.goal, msg.row.event.owner?.name ?? null);
      app.tv.push(msg.row);
    }
  }
});

boot().catch((err) => $app.replaceChildren(h('main', { class: 'stage centered' }, h('p', {}, err.message))));
