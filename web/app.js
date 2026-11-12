// Senju web app: sign up, teams, your API key, team and personal memory,
// and a live view of the team's session where anyone can talk to the lead.
const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
};
const app = $('#app');
const state = { sb: null, user: null, token: null, name: '', team: null, hasKey: false, ws: null, people: [], tab: 'people', live: null, target: 'lead', memory: [], history: [] };

function toast(message) {
  const t = h('div', { class: 'toast' }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 6000);
}

// ---- Start-up and sign-in -----------------------------------------------------------------

async function boot() {
  const cfg = await (await fetch('/api/config')).json();
  state.sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  state.sb.auth.onAuthStateChange((_event, session) => onSession(session));
  onSession((await state.sb.auth.getSession()).data.session);
}

let lastUser = null;
async function onSession(session) {
  state.token = session?.access_token ?? null;
  state.user = session?.user ?? null;
  if ((state.user?.id ?? null) === lastUser && state.user) return;   // token refresh, same person
  lastUser = state.user?.id ?? null;
  state.ws?.close();
  if (!state.user) return viewAuth();
  await loadAccount();
}

async function loadAccount() {
  const sb = state.sb;
  const { data: profile } = await sb.from('profiles').select('name').eq('id', state.user.id).maybeSingle();
  state.name = profile?.name ?? state.user.email;
  const { data: rows, error } = await sb.from('team_members').select('role, teams(id, name, invite_code)').eq('user_id', state.user.id).order('joined_at').limit(1);
  if (error) return toast(error.message);
  state.team = rows?.[0]?.teams ?? null;
  if (!state.team) return viewOnboarding();
  state.hasKey = Boolean((await sb.rpc('has_api_key')).data);
  connect();
  viewMain();
}

function viewAuth(mode = 'in') {
  const err = h('div', { class: 'error' });
  const submit = async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    const f = new FormData(ev.target);
    const creds = { email: f.get('email'), password: f.get('password') };
    const res = mode === 'up'
      ? await state.sb.auth.signUp({ ...creds, options: { data: { name: f.get('name') } } })
      : await state.sb.auth.signInWithPassword(creds);
    if (res.error) err.textContent = res.error.message;
    else if (mode === 'up' && !res.data.session) err.textContent = 'Check your email to confirm your account, then sign in.';
  };
  app.replaceChildren(h('div', { class: 'card narrow' },
    h('h1', {}, 'Senju'),
    h('p', { class: 'muted' }, mode === 'up' ? 'Create your account.' : 'Sign in to your team.'),
    h('form', { onsubmit: submit },
      mode === 'up' && h('input', { name: 'name', placeholder: 'Your name', required: true }),
      h('input', { name: 'email', type: 'email', placeholder: 'Email', required: true }),
      h('input', { name: 'password', type: 'password', placeholder: 'Password', required: true, minlength: 8 }),
      h('button', { class: 'primary', type: 'submit' }, mode === 'up' ? 'Create account' : 'Sign in'),
      err),
    h('p', { class: 'small muted' }, mode === 'up' ? 'Already have an account? ' : 'New here? ',
      h('button', { class: 'link', onclick: () => viewAuth(mode === 'up' ? 'in' : 'up') }, mode === 'up' ? 'Sign in' : 'Create an account'))));
}

function viewOnboarding() {
  const err = h('div', { class: 'error' });
  const run = (fn, arg) => async (ev) => {
    ev.preventDefault();
    const { error } = await state.sb.rpc(fn, { [arg]: new FormData(ev.target).get('v') });
    if (error) err.textContent = error.message; else loadAccount();
  };
  app.replaceChildren(h('div', { class: 'card narrow' },
    h('h1', {}, `Welcome, ${state.name}`),
    h('p', { class: 'muted' }, 'A team shares sessions, skills and team memory. Create one, or join with an invite code.'),
    h('h3', {}, 'Create a team'),
    h('form', { onsubmit: run('create_team', 'team_name') }, h('div', { class: 'row' }, h('input', { name: 'v', placeholder: 'Team name', required: true }), h('button', { class: 'primary' }, 'Create'))),
    h('h3', {}, 'Join a team'),
    h('form', { onsubmit: run('join_team', 'code') }, h('div', { class: 'row' }, h('input', { name: 'v', placeholder: 'Invite code', required: true }), h('button', {}, 'Join'))),
    err,
    h('p', { class: 'small' }, h('button', { class: 'link', onclick: () => state.sb.auth.signOut() }, 'Sign out'))));
}

// ---- Live connection to the team's hub --------------------------------------------------------

function connect() {
  const ws = new WebSocket(location.origin.replace(/^http/, 'ws'));
  state.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: state.token, role: 'web' }));
  ws.onmessage = (m) => onHub(JSON.parse(m.data));
  ws.onclose = () => { if (state.ws === ws && state.user) setTimeout(async () => { state.token = (await state.sb.auth.getSession()).data.session?.access_token ?? state.token; if (state.user) connect(); }, 2500); };
}
const say = (msg) => state.ws?.readyState === 1 && state.ws.send(JSON.stringify(msg));

function newLive(s) { return { id: s.id, goal: s.goal, owner: s.owner, agents: new Map(), lines: [], asks: new Map(), summary: null, lead: '', running: true }; }

function onHub(msg) {
  if (msg.t === 'welcome') {
    state.live = msg.session ? newLive(msg.session) : state.live;
    for (const e of msg.session?.replay ?? []) onEvent(e, true);
  } else if (msg.t === 'joined') {
    state.live = newLive(msg.session);
    for (const e of msg.session.replay ?? []) onEvent(e, true);
  } else if (msg.t === 'presence') {
    state.people = msg.people;
    if (msg.session && state.live?.id !== msg.session.id) state.live = newLive(msg.session);
    if (!msg.session && state.live) state.live.running = false;
  } else if (msg.t === 'event') {
    onEvent(msg.event);
  } else if (msg.t === 'error') {
    toast(msg.message);
  }
  render();
}

function onEvent(e) {
  if (e.type === 'session') { state.live = newLive(e); state.target = 'lead'; return; }
  const L = state.live;
  if (!L) return;
  if (e.type === 'spawn') L.agents.set(e.agent.id, { ...e.agent, status: 'starting', label: '' });
  else if (e.type === 'agent') { const a = L.agents.get(e.id); if (a) Object.assign(a, { status: e.status, label: e.label, deviceName: e.deviceName ?? a.deviceName }); }
  else if (e.type === 'lead') L.lead = e.label || e.status;
  else if (e.type === 'said') L.lines.push({ who: e.from.name, me: e.from.id === state.user.id, to: e.target, text: e.text });
  else if (e.type === 'chat') L.lines.push({ who: e.name, to: e.from, reply: true, text: e.text });
  else if (e.type === 'ask') L.asks.set(e.qid, e);
  else if (e.type === 'answered') L.asks.delete(e.qid);
  else if (e.type === 'done') { L.summary = e.summary; L.running = false; }
  else if (e.type === 'state' && e.state === 'idle') { L.running = false; L.asks.clear(); }
  else if (e.type === 'skill') L.lines.push({ who: 'Lead', reply: true, to: 'lead', text: `${e.created ? 'Learned a new skill' : 'Improved a skill'}: ${e.name}` });
  else if (e.type === 'remembered') L.lines.push({ who: 'Lead', reply: true, to: 'lead', text: `Remembered for ${e.scope === 'team' ? 'the team' : e.person}: ${e.note}` });
  else if (e.type === 'error') L.lines.push({ who: 'System', reply: true, to: 'lead', text: e.message });
}

// ---- Main view ------------------------------------------------------------------------------------

let draft = '';
function viewMain() { render(); loadMemory(); loadHistory(); }

function render() {
  if (!state.team || !state.user) return;
  const focused = document.activeElement?.id;
  if (focused === 'chat-input' || focused === 'goal-input') draft = document.activeElement.value;
  app.replaceChildren(
    h('header', {},
      h('h1', {}, 'Senju'), h('span', { class: 'muted' }, state.team.name), h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, state.name), h('button', { onclick: () => state.sb.auth.signOut() }, 'Sign out')),
    h('main', {}, sessionPanel(), sidePanel()));
  if (focused) { const el = document.getElementById(focused); if (el) { el.focus(); el.value = draft; } }
}

function sessionPanel() {
  const L = state.live;
  if (!L || (!L.running && !L.summary)) {
    return h('section', { class: 'card' },
      h('h2', {}, 'Start a session'),
      h('p', { class: 'muted small' }, 'The lead plans the work and sends agents to the computers your team has connected. A session runs on the API key of whoever starts it.'),
      !state.hasKey && h('p', { class: 'error' }, 'Add your API key under Settings before you start a session.'),
      h('form', { onsubmit: (ev) => { ev.preventDefault(); const goal = $('#goal-input').value.trim(); if (goal) { say({ t: 'start', goal }); draft = ''; } } },
        h('textarea', { id: 'goal-input', rows: 3, placeholder: 'What should the swarm do?' }),
        h('div', {}, h('button', { class: 'primary', type: 'submit', disabled: !state.hasKey }, 'Start'))));
  }
  // A teammate's session you have not joined: you are told it exists, and nothing of what is in it.
  const me = state.people.find((p) => p.id === state.user.id);
  if (L.running && me && !me.joined) {
    return h('section', { class: 'card' },
      h('h2', {}, L.goal),
      h('p', { class: 'muted small' }, `Started by ${L.owner.name}. ${L.agents.size} ${L.agents.size === 1 ? 'agent is' : 'agents are'} working.`),
      h('p', { class: 'small' }, 'Join to see the conversation and talk to the lead. Joining does not share your computer, and what is remembered about other people stays with them.'),
      h('div', {}, h('button', { class: 'primary', onclick: () => say({ t: 'join' }) }, 'Join session')));
  }
  const mine = [...L.asks.values()].filter((a) => !a.audience || a.audience.userId === state.user.id);
  const others = [...L.asks.values()].filter((a) => a.audience && a.audience.userId !== state.user.id);
  const isOwner = L.owner.id === state.user.id;
  return h('section', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { style: 'flex:1;margin:0' }, L.goal),
      L.running && isOwner && h('button', { class: 'danger', onclick: () => say({ t: 'cancel' }) }, 'Stop'),
      !L.running && h('button', { onclick: () => { state.live = null; render(); } }, 'New session')),
    h('p', { class: 'muted small' }, `Started by ${L.owner.name}${L.running ? `. Lead: ${L.lead || 'working'}` : '. Finished.'}`),
    L.summary && h('div', { class: 'summary' }, L.summary),
    h('h3', {}, 'Agents'),
    h('div', {},
      agentRow({ id: 'lead', name: 'Lead', color: '#f2f3f5', status: '', label: L.lead }),
      [...L.agents.values()].map(agentRow)),
    mine.map(askCard),
    others.map((a) => h('p', { class: 'muted small' }, `${L.agents.get(a.agentId)?.name ?? 'An agent'} is waiting for ${a.audience.userName} at their computer.`)),
    h('h3', {}, `Chat with ${state.target === 'lead' ? 'the lead' : L.agents.get(state.target)?.name ?? 'the lead'}`),
    h('div', { class: 'thread' }, L.lines.filter((l) => l.to === state.target).map((l) =>
      h('div', { class: l.me ? 'line me' : 'line' }, h('b', {}, l.me ? 'You' : l.who), l.text))),
    L.running && h('form', { style: 'margin-top:8px', onsubmit: (ev) => { ev.preventDefault(); const text = $('#chat-input').value.trim(); if (text) { say({ t: 'chat', text, target: state.target }); draft = ''; $('#chat-input').value = ''; } } },
      h('div', { class: 'row' }, h('input', { id: 'chat-input', placeholder: 'Ask for progress or change the plan. Click an agent to talk to it instead.' }), h('button', { class: 'primary' }, 'Send'))));
}

function agentRow(a) {
  return h('div', { class: `agent pick${state.target === a.id ? ' sel' : ''}`, onclick: () => { state.target = a.id; render(); } },
    h('span', { class: 'dot', style: `background:${a.color}` }), h('b', {}, a.name),
    h('span', { class: 'label' }, a.status === 'waiting' ? 'needs someone' : a.label || a.status),
    a.deviceName && h('span', { class: 'where' }, `on ${a.deviceName}`));
}

function askCard(a) {
  const L = state.live;
  const who = a.agentId === 'lead' ? 'Lead' : L.agents.get(a.agentId)?.name ?? 'Agent';
  const answer = (text) => say({ t: 'answer', qid: a.qid, text });
  const input = h('input', { placeholder: a.kind === 'question' ? 'Type your answer' : a.replyHint ? `Type ${a.replyHint}` : 'Optional note' });
  return h('div', { class: 'ask' },
    h('div', { class: 'who' }, `${who} ${a.kind === 'question' ? 'has a question' : 'needs you to do something'}${a.audience ? ' at your computer' : ''}`),
    h('div', {}, a.kind === 'question' ? a.question : a.kind === 'task' ? a.task : a.reason),
    a.kind !== 'question' && h('div', { class: 'steps' }, a.kind === 'task' ? [a.where && `Where: ${a.where}`, a.doneWhen && `It will check: ${a.doneWhen}`].filter(Boolean).join('\n') : `${a.steps}\nIt will check: ${a.doneWhen}`),
    h('div', { class: 'buttons' },
      a.kind === 'question' ? (a.options ?? []).map((o) => h('button', { onclick: () => answer(o) }, o))
        : [h('button', { class: 'primary', onclick: () => answer('Done') }, 'Done'), h('button', { onclick: () => answer('The user cannot do this. Stop this part and report.') }, "I can't do this")]),
    h('form', { style: 'margin-top:8px', onsubmit: (ev) => { ev.preventDefault(); if (input.value.trim() || a.kind !== 'question') answer(input.value.trim() || 'Done'); } },
      h('div', { class: 'row' }, input, h('button', {}, 'Reply'))));
}

function sidePanel() {
  const tabs = ['people', 'memory', 'history', 'settings'];
  return h('section', { class: 'card' },
    h('div', { class: 'tabs' }, tabs.map((t) => h('button', { class: state.tab === t ? 'on' : '', onclick: () => { state.tab = t; if (t === 'memory') loadMemory(); if (t === 'history') loadHistory(); render(); } }, t[0].toUpperCase() + t.slice(1)))),
    { people: peopleTab, memory: memoryTab, history: historyTab, settings: settingsTab }[state.tab]());
}

function peopleTab() {
  return h('div', {},
    h('p', { class: 'muted small' }, 'Who is online, and which computers are connected. A computer joins a session only after its owner allows it.'),
    state.people.length === 0 && h('p', { class: 'muted' }, 'Nobody else is online.'),
    state.people.map((p) => h('div', { class: 'item' },
      h('b', {}, p.name), p.id === state.user.id && h('span', { class: 'pill' }, 'you'), p.web && h('span', { class: 'pill' }, 'web'),
      p.devices.map((d) => h('div', { class: 'meta' }, d.name, h('span', { class: `pill${d.inSession ? ' on' : ''}` }, d.inSession ? 'in session' : d.asked ? 'asked to join' : 'connected'))),
      p.devices.length === 0 && h('div', { class: 'meta' }, 'No computer connected'))),
    h('h3', {}, 'Invite a teammate'),
    h('p', { class: 'small' }, 'Invite code: ', h('code', {}, state.team.invite_code)));
}

async function loadMemory() {
  const { data } = await state.sb.from('memories')
    .select('id, kind, scope, name, description, body, revision, updated_at, author:profiles!memories_author_id_fkey(name)')
    .order('updated_at', { ascending: false }).limit(200);
  state.memory = data ?? [];
  if (state.tab === 'memory') render();
}

function memoryTab() {
  const forget = async (m) => { await state.sb.from('memories').delete().eq('id', m.id); loadMemory(); };
  const group = (title, hint, rows) => [h('h3', {}, title), h('p', { class: 'muted small' }, hint),
    rows.length === 0 ? h('p', { class: 'muted small' }, 'Nothing yet.') : rows.map((m) => h('div', { class: 'item' },
      m.kind === 'skill' && h('b', {}, m.name), m.kind === 'skill' && h('span', { class: 'pill' }, `revision ${m.revision}`),
      m.kind === 'skill' ? h('div', { class: 'small' }, m.description) : h('div', {}, m.body),
      m.kind === 'skill' && h('details', {}, h('summary', { class: 'small muted' }, 'Show'), h('pre', {}, m.body)),
      h('div', { class: 'meta' }, `From ${m.author?.name ?? 'someone'}, ${new Date(m.updated_at).toLocaleDateString()} `, h('button', { class: 'link', onclick: () => forget(m) }, 'Forget'))))];
  return h('div', {},
    group('About you', 'Only you can see these. Each one records who said it.', state.memory.filter((m) => m.kind === 'note' && m.scope === 'user')),
    group('Team notes', 'Visible to your whole team.', state.memory.filter((m) => m.kind === 'note' && m.scope === 'team')),
    group('Team skills', 'Written by the lead after sessions, credited to the session owner.', state.memory.filter((m) => m.kind === 'skill')));
}

async function loadHistory() {
  const { data } = await state.sb.from('sessions').select('id, goal, status, summary, started_at, owner:profiles!sessions_owner_id_fkey(name)').order('started_at', { ascending: false }).limit(30);
  state.history = data ?? [];
  if (state.tab === 'history') render();
}

function historyTab() {
  return h('div', {}, state.history.length === 0 ? h('p', { class: 'muted' }, 'No sessions yet.') : state.history.map((s) => h('div', { class: 'item' },
    h('b', {}, s.goal), h('span', { class: 'pill' }, s.status),
    h('div', { class: 'meta' }, `${s.owner?.name ?? 'Someone'}, ${new Date(s.started_at).toLocaleString()}`),
    s.summary && h('details', {}, h('summary', { class: 'small muted' }, 'Summary'), h('pre', {}, s.summary)))));
}

function settingsTab() {
  const err = h('div', { class: 'error' });
  const keyCall = async (method, body) => {
    const res = await fetch('/api/key', { method, headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const out = await res.json();
    if (!res.ok) { err.textContent = out.error; return false; }
    state.hasKey = method === 'POST';
    render();
    return true;
  };
  return h('div', {},
    h('h3', {}, 'Your Anthropic API key'),
    h('p', { class: 'muted small' }, 'Sessions you start run on your key. It is encrypted on the server and never shown again, and teammates cannot use it for their own sessions.'),
    state.hasKey
      ? h('p', {}, 'A key is saved. ', h('button', { class: 'link', onclick: () => keyCall('DELETE') }, 'Remove it'))
      : h('form', { onsubmit: (ev) => { ev.preventDefault(); keyCall('POST', { key: new FormData(ev.target).get('key') }); } },
        h('div', { class: 'row' }, h('input', { name: 'key', type: 'password', placeholder: 'sk-ant-...', required: true, autocomplete: 'off' }), h('button', { class: 'primary' }, 'Save'))),
    err,
    h('h3', {}, 'Team'),
    h('p', { class: 'small' }, `${state.team.name}. Invite code: `, h('code', {}, state.team.invite_code)),
    h('h3', {}, 'Desktop app'),
    h('p', { class: 'muted small' }, 'To connect a computer, put this address under "cloud" in the desktop app\'s swarm.config.json and sign in there with this account:'),
    h('p', {}, h('code', {}, location.origin)));
}

boot().catch((err) => { app.replaceChildren(h('p', { class: 'center error' }, `Could not start: ${err.message}`)); });
