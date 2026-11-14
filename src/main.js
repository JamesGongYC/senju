// Electron main process: the overlay window, hotkey, and the bridge between UI and swarm.
import { app, BrowserWindow, globalShortcut, ipcMain, safeStorage, screen, shell, Tray, Menu, nativeImage, Notification, powerMonitor, powerSaveBlocker, systemPreferences } from 'electron';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ROOT, dataDir, loadEnv, loadConfig, ensureWorkspace } from './config.js';
import { Swarm } from './orchestrator.js';
import { listWindows, processParents, pickWindow } from './windows.js';
import { demoLlm, demoConnect, demoConfigServers } from './demo.js';
import { placeWindow } from './place.js';
import { callTool } from './mcp.js';
import { makeLlm as claude } from './llm.js';
import { ToolHost } from './toolhost.js';
import { CloudClient, supabaseAuth } from './cloud.js';
import { DEFAULT_HUB } from './config.js';

const DEMO = process.argv.includes('--demo') || process.env.SWARM_DEMO === '1';

// Installed app: settings, traces and skills live in the app's data folder, and the shell's
// PATH is recovered, because an app opened from Finder does not get it (tools such as
// cua-driver would not be found otherwise).
if (app.isPackaged) {
  process.env.SWARM_DATA_DIR = app.getPath('userData');
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__PATH__%s__END__" "$PATH"'], { timeout: 5000, encoding: 'utf8' });
      const found = /__PATH__(.*)__END__/s.exec(out)?.[1];
      if (found) process.env.PATH = found;
    } catch { /* keep the default PATH */ }
  }
}

// The solo API key, encrypted with the system keychain and kept in the data folder.
const keyFile = () => path.join(dataDir(), 'api-key.bin');
function loadSavedKey() {
  try {
    if (!process.env.ANTHROPIC_API_KEY && fs.existsSync(keyFile()) && safeStorage.isEncryptionAvailable()) {
      process.env.ANTHROPIC_API_KEY = safeStorage.decryptString(fs.readFileSync(keyFile()));
    }
  } catch { /* unreadable: ask again */ }
}
function saveKey(key) {
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) return 'That does not look like an Anthropic API key.';
  if (!safeStorage.isEncryptionAvailable()) return 'This computer cannot store the key securely. Put ANTHROPIC_API_KEY=... in a .env file in the data folder instead.';
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(keyFile(), safeStorage.encryptString(key), { mode: 0o600 });
  process.env.ANTHROPIC_API_KEY = key;
  return null;
}
const isMac = process.platform === 'darwin';
// Two ways to work, chosen each time the app opens: on this Mac only, or signed in to a team.
// TEAM is true once team mode is chosen; `mode` stays null until the choice is made.
let TEAM = false;
let mode = null;

loadEnv();
const config = loadConfig();
if (DEMO) config.servers = demoConfigServers;
const workspace = ensureWorkspace();

let win = null;
let tray = null;
let swarm = null;
let cloud = null;           // team mode: the connection to the hub
let host = null;            // team mode: runs this computer's tools for agents on the hub
let awake = null;
let area = { x: 0, y: 0, width: 1280, height: 800 };
let tracker = null;
let retrack = null;   // re-check window positions now (the user switched desktops)
const moved = new Map();    // pid -> the frame an app's window had before we tiled it
let tilingDenied = false;
let hotkey = null;          // the accelerator that actually registered
let toldHowToReturn = false;

// "CommandOrControl+Shift+Space" -> "⌘⇧Space"
const pretty = (acc) => String(acc ?? '').split('+').map((k) => ({
  CommandOrControl: isMac ? '⌘' : 'Ctrl+', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Shift: '⇧', Alt: '⌥', Option: '⌥',
}[k] ?? k)).join('');

// A banner for moments worth coming back for, since long jobs run while you are elsewhere.
function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body: String(body ?? '').slice(0, 240), silent: true }).show();
}

// Ghost cursors on what an agent is doing.
// The orchestrator emits (src/point.js) { type: 'point', agentId, point } just before an action: an element's centre for click, type and
// select, or just the verb for open (address bar), back (back button) and key (stay put). The cursor glides there
// and STAYS, relative to that agent's window, until the next point: it never snaps back to a parking spot.
const pointing = new Map();   // agentId -> { dx, dy } from its window's top-left, or { x, y } when there is no window
const chromeTops = new Map(); // agentId -> height of the tab and address bars in that window, from measured points
let lastTargets = {};
const clampX = (x) => Math.max(0, Math.min(area.width - 20, x));
const clampY = (y) => Math.max(0, Math.min(area.height - 20, y));
function pointTarget(agentId, point) {
  const t = lastTargets[agentId];
  let x, y;
  if (Number.isFinite(point?.screenX) && Number.isFinite(point?.screenY)) { x = point.screenX - area.x; y = point.screenY - area.y; }
  else if (t?.rect && Number.isFinite(point?.x) && point.windowW) { x = t.rect.x + point.x * (t.rect.w / point.windowW); y = t.rect.y + point.y * (t.rect.h / (point.windowH || t.rect.h)); }
  else return null;
  return { x: clampX(x), y: clampY(y) };
}

// -> { x, y, from?, kind, ms, text? } in overlay px: where the cursor goes for this point, and how to play it.
function cursorMove(agentId, point) {
  const t = lastTargets[agentId];
  const scale = t?.rect && point?.windowW ? t.rect.w / point.windowW : 1;
  if (Number.isFinite(point?.chromeTop)) chromeTops.set(agentId, point.chromeTop);
  const verb = point?.verb;
  if (verb === 'open' || verb === 'back') {
    if (!t?.rect) return null;
    // Chrome's address bar sits about 25 px above the page; the back button is at its left end.
    const y = t.rect.y + ((chromeTops.get(agentId) ?? 87) - 25) * scale;
    if (verb === 'back') return { x: clampX(t.rect.x + 23 * scale), y: clampY(y), kind: 'click', ms: 0 };
    const x = t.rect.x + Math.min(t.rect.w * 0.3, 360 * scale);
    return { x: clampX(x), y: clampY(y), kind: 'type', ms: Number(point.typeMs) || 0, text: String(point.url ?? ''), from: { x: clampX(t.rect.x + 150 * scale), y: clampY(y) } };
  }
  if (verb === 'key') {
    const at = lastTargets[agentId];
    return at && Number.isFinite(at.x) ? { x: at.x, y: at.y, kind: 'key', ms: 0 } : null;
  }
  const spot = pointTarget(agentId, point);
  if (!spot) return null;
  if (verb === 'type' && point.w) {
    // Start at the left of the field and run right as the letters appear, about 7 px a letter.
    const half = (point.w * scale) / 2;
    const from = { x: clampX(spot.x - half + 8 * scale), y: spot.y };
    const end = Math.min(spot.x + half - 8 * scale, from.x + (point.chars ?? 0) * 7 * scale);
    return { x: clampX(Math.max(from.x, end)), y: spot.y, from, kind: 'type', ms: Number(point.typeMs) || 0 };
  }
  return { ...spot, kind: 'click', ms: 0 };
}

const send = (event) => {
  if (!win || win.isDestroyed()) return;
  if (event.type === 'point') {
    if (lastTargets[event.agentId]?.elsewhere) return;   // acting on another desktop: nothing to show here
    const move = cursorMove(event.agentId, event.point);
    if (!move) return;
    const rect = lastTargets[event.agentId]?.rect;
    pointing.set(event.agentId, rect ? { dx: move.x - rect.x, dy: move.y - rect.y } : { x: move.x, y: move.y });
    lastTargets = { ...lastTargets, [event.agentId]: { ...(lastTargets[event.agentId] ?? {}), x: move.x, y: move.y } };
    win.webContents.send('swarm:event', { type: 'cursor', agentId: event.agentId, ...move });
    return;
  }
  // Hidden while a job runs: come back when the user is needed or the job is over.
  if ((event.type === 'ask' || event.type === 'done' || event.type === 'error' || event.type === 'consent') && !win.isVisible()) summon();
  if (event.type === 'consent') { shell.beep(); notify(`${event.session.owner.name} wants to use this Mac`, event.session.goal); }
  if (TEAM && event.type === 'state') onTeamState(event.state);
  if (event.type === 'ask') {   // an agent needs the user
    shell.beep();
    // In a team, a request addressed to someone else's computer is not ours to announce.
    if (event.audience && event.audience.deviceId !== cloud?.device.id) return win.webContents.send('swarm:event', event);
    const who = event.agentId === 'lead' ? 'The lead' : agentsNow().find((a) => a.id === event.agentId)?.name ?? 'An agent';
    notify(`${who} needs you`, event.kind === 'handoff' ? event.reason : event.kind === 'task' ? event.task : event.question);
  }
  if (event.type === 'done') notify('Senju finished', event.summary);
  win.webContents.send('swarm:event', event);
};

function makeLlm() {
  if (DEMO) return demoLlm;
  return process.env.ANTHROPIC_API_KEY ? claude(process.env.ANTHROPIC_API_KEY) : null;
}

// Solo and team mode keep their agents in different places.
const agentsNow = () => (TEAM ? [...(host?.agents.values() ?? [])] : swarm?.agents ?? []);
const isRunning = () => (TEAM ? Boolean(cloud?.running) : Boolean(swarm?.running));

// Move an app's window to `rect`. The desktop driver does it when it is running, because it already
// holds the Accessibility permission. Otherwise System Events does, which needs that permission
// granted to whatever launched Senju. Resolves { ok, previous } or { ok: false, denied }.
async function arrange(server, target, rect) {
  const conn = (TEAM ? host?.shared : swarm?.shared)?.get(server);
  if (target.id && conn?.tools?.some((t) => t.name === 'set_window_frame')) {
    const res = await callTool(conn, 'set_window_frame', { pid: target.pid, window_id: target.id, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.w), height: Math.round(rect.h) });
    if (!res.isError) return { ok: true, previous: { x: target.x, y: target.y, w: target.w, h: target.h } };
  }
  return placeWindow(target.pid, rect);
}

function restoreWindows() {
  if (config.restoreWindows !== false) for (const [pid, was] of moved) arrange(was.server, { pid, id: was.id }, was.frame).catch(() => {});
  moved.clear();
}

// Team mode: follow the session's lifecycle as the hub reports it.
function onTeamState(state) {
  if (state === 'running' || state === 'planning') {
    startTracking();
    awake ??= powerSaveBlocker.start('prevent-app-suspension');
  } else if (state === 'idle') {
    stopTracking();
    if (awake != null) { powerSaveBlocker.stop(awake); awake = null; }
  }
}

// A stable id for this computer, so the hub recognizes it across restarts.
function deviceIdentity() {
  const file = path.join(app.getPath('userData'), 'device.json');
  let id;
  try { id = JSON.parse(fs.readFileSync(file, 'utf8')).id; } catch { /* first run */ }
  if (!id) { id = crypto.randomUUID(); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ id })); }
  const name = config.cloud?.deviceName ?? os.hostname().replace(/\.local$/, '').replace(/[-_]+/g, ' ');
  return { id, name, platform: process.platform };
}

const HUB = String(config.cloud?.url || DEFAULT_HUB).replace(/\/+$/, '');
let teamRetry = null;
async function startTeamMode() {
  if (!TEAM) return;
  host = new ToolHost({ config, workspace, layout, idle: () => powerMonitor.getSystemIdleTime(), emit: send });
  const mine = host;
  try {
    const auth = await supabaseAuth(HUB, path.join(app.getPath('userData'), 'session.json'));
    if (!TEAM || host !== mine) return;   // switched away while connecting
    cloud = new CloudClient({ url: HUB, auth, host, device: deviceIdentity(), send, onSessionOver: restoreWindows });
    await cloud.start();
  } catch (err) {
    if (!TEAM || host !== mine) return;
    send({ type: 'account', state: 'offline', url: HUB, error: `Could not reach the team server: ${err?.message ?? err}` });
    teamRetry = setTimeout(startTeamMode, 15000);
  }
}

// The last choice is remembered only to put it first next time; the question is asked on every launch
// unless "mode" in swarm.config.json is "local" or "team".
const modeFile = () => path.join(app.getPath('userData'), 'mode.json');
function lastMode() { try { return JSON.parse(fs.readFileSync(modeFile(), 'utf8')).mode === 'team' ? 'team' : 'local'; } catch { return 'local'; } }

async function setMode(next) {
  next = next === 'team' ? 'team' : 'local';
  if (DEMO) next = 'local';
  if (next === mode) return send({ type: 'mode', mode, team: TEAM });
  if (isRunning()) return send({ type: 'notice', message: 'A job is running. Stop it before switching.' });
  // Leave the old mode completely before entering the new one.
  clearTimeout(teamRetry);
  const oldCloud = cloud, oldHost = host;
  cloud = null; host = null;
  TEAM = next === 'team';
  mode = next;
  try { await (oldCloud ? oldCloud.shutdown() : oldHost?.shutdown()); } catch { /* already gone */ }
  if (!TEAM && swarm) { try { await swarm.shutdown(); } catch { /* nothing to close */ } swarm = null; }
  try { fs.writeFileSync(modeFile(), JSON.stringify({ mode })); } catch { /* the choice just is not remembered */ }
  buildTray();
  send({ type: 'mode', mode, team: TEAM });
  if (TEAM) startTeamMode();
}

function buildTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Show prompt${hotkey ? `   ${pretty(hotkey)}` : ''}`, click: summon },
    { label: 'Hide', click: dismiss },
    { type: 'separator' },
    { label: 'On this Mac', type: 'radio', checked: mode === 'local', click: () => { setMode('local'); summon(); } },
    { label: 'With my team', type: 'radio', checked: mode === 'team', enabled: !DEMO, click: () => { setMode('team'); summon(); } },
    { type: 'separator' },
    { label: 'Open settings folder', click: () => shell.openPath(dataDir()) },
    { label: 'Stop current job', click: () => (TEAM ? cloud?.cancel() : swarm?.cancel()) },
    ...(TEAM ? [{ label: 'Sign out', click: () => cloud?.signOut() }] : []),
    { type: 'separator' },
    { label: 'Quit Senju', click: () => app.quit() },
  ]));
}

function createWindow() {
  area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    x: area.x, y: area.y, width: area.width, height: area.height,
    transparent: true, frame: false, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, show: false,
    ...(isMac ? { type: 'panel' } : {}),   // panel: takes keys without activating our app
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.cjs'), contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });   // clicks pass through to your apps
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.once('ready-to-show', () => summon());
}

function summon() {
  if (!win) return;
  win.show();
  win.focus();
  send({ type: 'summon', demo: DEMO, hotkey: pretty(hotkey), team: TEAM, mode, lastMode: mode ? mode : lastMode() });
}

// Hide the overlay. A running job keeps going in the background unless
// "dismissCancels" is set; it reappears by itself when an agent needs you or finishes.
function dismiss() {
  if (config.dismissCancels && !TEAM) swarm?.cancel();
  win?.hide();
  if (!toldHowToReturn) {
    toldHowToReturn = true;
    notify('Senju is hidden', `${isRunning() ? 'The job is still running. ' : ''}Press ${hotkey ? pretty(hotkey) : 'the ◎ menu bar icon'} to bring it back.`);
  }
}

// Bind the show/hide key. If the configured one is taken by another app, try a few others.
function bindHotkey() {
  const wanted = [config.hotkey, 'CommandOrControl+Shift+Space', 'Alt+Space', 'CommandOrControl+Shift+K', 'CommandOrControl+Alt+S'].filter(Boolean);
  const toggle = () => { if (win?.isVisible()) dismiss(); else summon(); };
  for (const acc of [...new Set(wanted)]) {
    try {
      if (globalShortcut.register(acc, toggle)) { hotkey = acc; break; }
    } catch { /* invalid accelerator in config: try the next */ }
  }
  if (!hotkey) send({ type: 'notice', message: 'No show/hide key could be registered. Use the ◎ menu bar icon, or set "hotkey" in swarm.config.json.' });
  else if (hotkey !== config.hotkey) send({ type: 'notice', message: `${pretty(config.hotkey)} is taken by another app, so show/hide is on ${pretty(hotkey)}.` });
}

// Split the screen below the prompt bar into one slot per agent window (screen points).
function layout(count) {
  const top = 118, gap = 8;
  const cols = count <= 3 ? count : Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const w = Math.floor((area.width - gap * (cols + 1)) / cols);
  const h = Math.floor((area.height - top - gap * rows) / rows);
  return Array.from({ length: count }, (_, i) => ({
    x: area.x + gap + (i % cols) * (w + gap),
    y: area.y + top + Math.floor(i / cols) * (h + gap),
    w, h,
  }));
}

// While a job runs, keep each ghost cursor on the window of the app its agent is using.
function startTracking() {
  stopTracking();
  pointing.clear();   // a new job: cursors start from their windows again
  chromeTops.clear();
  const tick = async () => {
    if (!isRunning() || !win?.isVisible()) return;
    const [windows, parents] = await Promise.all([listWindows({ all: true }), processParents()]);
    const targets = {};
    agentsNow().forEach((agent, i) => {
      // In a team, an agent working on someone else's computer has nothing to place here.
      if (TEAM && agent.device && agent.device !== cloud?.device.id) return;
      const appName = agent.server ? config.servers[agent.server]?.app : null;
      // The agent's own window if it has one, else the app's window, else its tile slot.
      const own = agent.pids.length ? pickWindow(agent, null, windows, parents, i) : null;
      const w = own ?? (agent.server ? pickWindow(agent, appName, windows, parents, i) : null) ?? agent.slot;
      // Its window is on another desktop (Space), or minimized: the overlay shows on every desktop,
      // so hide the cursor rather than leave it over windows it is not working in.
      if (w && w.onScreen === false) { targets[agent.id] = { app: w.app ?? appName ?? null, elsewhere: true }; return; }
      // A desktop agent's app window is moved into the agent's slot the first time it is used.
      const isDesktop = config.servers[agent.server]?.kind === 'desktop';
      if (isDesktop && agent.live && agent.slot && w && w !== agent.slot && w.pid && agent.placedPid !== w.pid && !tilingDenied) {
        agent.placedPid = w.pid;
        const pid = w.pid, server = agent.server;
        arrange(server, w, agent.slot).then((res) => {
          if (res.ok) { if (!moved.has(pid)) moved.set(pid, { frame: res.previous, id: w.id, server }); }
          else if (res.denied) {
            tilingDenied = true;
            send({ type: 'notice', message: 'Could not arrange app windows, so they stay where they are. Agents still work. To allow it, add the app you start Senju from to System Settings > Privacy & Security > Accessibility, then quit and reopen that app.' });
          }
        }).catch(() => {});
      }
      if (!w) { targets[agent.id] = { app: appName ?? null }; return; }
      const tiled = w === agent.slot || own;
      // In its own window the cursor idles near the top right, away from the page's main content.
      const fx = tiled ? 0.8 : 0.22 + 0.19 * (i % 4);
      const fy = tiled ? 0.22 : 0.28 + 0.12 * (i % 3);
      targets[agent.id] = {
        app: w.app ?? appName ?? null,
        x: Math.max(8, Math.min(area.width - 40, w.x - area.x + w.w * fx)),
        y: Math.max(90, Math.min(area.height - 40, w.y - area.y + w.h * fy)),
        rect: { x: w.x - area.x, y: w.y - area.y, w: w.w, h: w.h },
      };
    });
    // An agent's cursor stays where it last acted, and moves with its window.
    for (const [id, p] of pointing) {
      const t = targets[id];
      if (!t || t.elsewhere) continue;
      if (t.rect && Number.isFinite(p.dx)) targets[id] = { ...t, x: clampX(t.rect.x + p.dx), y: clampY(t.rect.y + p.dy) };
      else if (Number.isFinite(p.x)) targets[id] = { ...t, x: p.x, y: p.y };
    }
    lastTargets = targets;
    send({ type: 'targets', targets });
  };
  tick();
  tracker = setInterval(tick, 1500);
  retrack = tick;
}

function stopTracking() {
  if (tracker) clearInterval(tracker);
  tracker = null;
  retrack = null;
}

app.whenReady().then(() => {
  if (isMac) app.dock?.hide();
  loadSavedKey();
  createWindow();
  // Switching desktops (Spaces): hide or show cursors for the desktop now in front right away, not on the next tick.
  if (isMac) systemPreferences.subscribeWorkspaceNotification('NSWorkspaceActiveSpaceDidChangeNotification', () => retrack?.());

  bindHotkey();

  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('◎');
  tray.setToolTip('Senju');
  buildTray();
  ipcMain.on('app:mode', (_e, next) => setMode(next));

  ipcMain.on('overlay:interactive', (_e, on) => win?.setIgnoreMouseEvents(!on, { forward: true }));
  ipcMain.on('swarm:dismiss', dismiss);
  // Reset: back to a fresh bar. Forget the last job, close the windows finished workers left open and put
  // moved app windows back. Never during a job.
  ipcMain.on('swarm:reset', async () => {
    if (isRunning()) return send({ type: 'notice', message: 'A job is running. Stop it first, then reset.' });
    pointing.clear();
    chromeTops.clear();
    lastTargets = {};
    if (!TEAM && swarm) { swarm.lastJob = null; await swarm.closeKept().catch(() => {}); }
    restoreWindows();
    send({ type: 'reset' });
  });
  ipcMain.on('solo:key', (_e, key) => {
    const problem = saveKey(String(key ?? '').trim());
    send(problem ? { type: 'need_key', error: problem } : { type: 'key_saved' });
  });
  ipcMain.on('app:open-data', () => shell.openPath(dataDir()));
  ipcMain.on('swarm:cancel', () => (TEAM ? cloud?.cancel() : swarm?.cancel()));
  ipcMain.on('swarm:pause', (_e, { id, paused }) => (TEAM ? cloud?.pause(id, paused) : swarm?.setPaused(id, paused)));
  ipcMain.on('swarm:stop-agent', (_e, id) => (TEAM ? cloud?.stopAgent(id) : swarm?.stopAgent(id)));
  ipcMain.on('swarm:answer', (_e, { qid, text }) => (TEAM ? cloud?.answer(qid, text) : swarm?.answer(qid, text)));
  // Team mode only: account and consent.
  ipcMain.on('team:signin', (_e, { email, password }) => cloud?.signIn(email, password));
  ipcMain.on('team:signout', () => cloud?.signOut());
  ipcMain.on('team:consent', (_e, { allow, watch }) => cloud?.consent(allow, watch));
  ipcMain.on('team:join', () => cloud?.join());
  ipcMain.on('team:leave', () => cloud?.leave());
  ipcMain.on('swarm:tell', (_e, { text, target }) => {
    if (TEAM) return cloud?.chat(text, target ?? 'lead');
    if (!swarm?.tell(text, target ?? 'lead')) send({ type: 'notice', message: 'That agent is no longer working, so the message was not delivered.' });
  });
  ipcMain.on('swarm:submit', async (_e, goal) => {
    goal = String(goal ?? '').trim();
    if (!mode) return;   // the way of working has not been chosen yet
    if (TEAM) { if (goal) cloud?.startSession(goal); return; }
    if (!goal) return;
    if (swarm?.running) return send({ type: 'notice', message: 'The last job is still wrapping up. Send it again in a moment.' });
    if (!swarm) {
      const llm = makeLlm();
      if (!llm) return send({ type: 'need_key', goal });   // the bar asks for the key, then runs the goal
      swarm = new Swarm({
        llm, config, workspace, emit: send, layout,
        idle: () => powerMonitor.getSystemIdleTime(),
        traceDir: config.trace === false ? null : path.join(dataDir(), 'traces'),
        skillsDir: config.skills === false ? null : DEMO ? path.join(app.getPath('temp'), 'senju-demo-skills') : path.join(dataDir(), 'skills'),
        ...(DEMO ? { connect: demoConnect } : {}),
      });
    }
    startTracking();
    // Keep the Mac from sleeping mid-job (the display may still turn off).
    const keepAwake = powerSaveBlocker.start('prevent-app-suspension');
    try {
      await swarm.run(goal);
    } finally {
      powerSaveBlocker.stop(keepAwake);
      stopTracking();
      restoreWindows();   // put the user's app windows back where they were
    }
  });

  // Demo and a fixed "mode" in the settings skip the question; otherwise the bar asks on every launch.
  const fixed = DEMO ? 'local' : ['local', 'team'].includes(config.mode) ? config.mode : null;
  if (fixed) win.webContents.once('did-finish-load', () => setMode(fixed));
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  await swarm?.shutdown();
  await cloud?.shutdown();
});
app.on('window-all-closed', () => app.quit());
