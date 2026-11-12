// Electron main process: the overlay window, hotkey, and the bridge between UI and swarm.
import { app, BrowserWindow, globalShortcut, ipcMain, safeStorage, screen, shell, Tray, Menu, nativeImage, Notification, powerMonitor, powerSaveBlocker } from 'electron';
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
import { makeLlm as claude } from './llm.js';
import { ToolHost } from './toolhost.js';
import { CloudClient, supabaseAuth } from './cloud.js';

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
// Team mode: a server address under "cloud" in swarm.config.json. Otherwise the app runs solo.
const TEAM = !DEMO && Boolean(loadConfig().cloud?.url);

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

const send = (event) => {
  if (!win || win.isDestroyed()) return;
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

function restoreWindows() {
  if (config.restoreWindows !== false) for (const [pid, frame] of moved) placeWindow(pid, frame);
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

async function startTeamMode() {
  host = new ToolHost({ config, workspace, layout, idle: () => powerMonitor.getSystemIdleTime(), emit: send });
  try {
    const auth = await supabaseAuth(config.cloud.url, path.join(app.getPath('userData'), 'session.json'));
    cloud = new CloudClient({ url: config.cloud.url, auth, host, device: deviceIdentity(), send, onSessionOver: restoreWindows });
    await cloud.start();
  } catch (err) {
    send({ type: 'account', state: 'offline', url: config.cloud.url, error: `Could not reach the team server: ${err?.message ?? err}` });
    setTimeout(startTeamMode, 15000);
  }
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
  send({ type: 'summon', demo: DEMO, hotkey: pretty(hotkey), team: TEAM });
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
  const tick = async () => {
    if (!isRunning() || !win?.isVisible()) return;
    const [windows, parents] = await Promise.all([listWindows(), processParents()]);
    const targets = {};
    agentsNow().forEach((agent, i) => {
      // In a team, an agent working on someone else's computer has nothing to place here.
      if (TEAM && agent.device && agent.device !== cloud?.device.id) return;
      const appName = agent.server ? config.servers[agent.server]?.app : null;
      // The agent's own window if it has one, else the app's window, else its tile slot.
      const own = agent.pids.length ? pickWindow(agent, null, windows, parents, i) : null;
      const w = own ?? (agent.server ? pickWindow(agent, appName, windows, parents, i) : null) ?? agent.slot;
      // A desktop agent's app window is moved into the agent's slot the first time it is used.
      const isDesktop = config.servers[agent.server]?.kind === 'desktop';
      if (isDesktop && agent.live && agent.slot && w && w !== agent.slot && w.pid && agent.placedPid !== w.pid && !tilingDenied) {
        agent.placedPid = w.pid;
        const pid = w.pid;
        placeWindow(pid, agent.slot).then((res) => {
          if (res.ok) { if (!moved.has(pid)) moved.set(pid, res.previous); }
          else if (res.denied) {
            tilingDenied = true;
            send({ type: 'notice', message: 'Could not arrange app windows. In System Settings > Privacy & Security, allow your terminal under Accessibility and under Automation > System Events.' });
          }
        });
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
    send({ type: 'targets', targets });
  };
  tick();
  tracker = setInterval(tick, 1500);
}

function stopTracking() {
  if (tracker) clearInterval(tracker);
  tracker = null;
}

app.whenReady().then(() => {
  if (isMac) app.dock?.hide();
  loadSavedKey();
  createWindow();

  bindHotkey();

  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('◎');
  tray.setToolTip('Senju');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Show prompt${hotkey ? `   ${pretty(hotkey)}` : ''}`, click: summon },
    { label: 'Hide', click: dismiss },
    { label: 'Open settings folder', click: () => shell.openPath(dataDir()) },
    { label: 'Stop current job', click: () => (TEAM ? cloud?.cancel() : swarm?.cancel()) },
    ...(TEAM ? [{ label: 'Sign out', click: () => cloud?.signOut() }] : []),
    { type: 'separator' },
    { label: 'Quit Senju', click: () => app.quit() },
  ]));

  ipcMain.on('overlay:interactive', (_e, on) => win?.setIgnoreMouseEvents(!on, { forward: true }));
  ipcMain.on('swarm:dismiss', dismiss);
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
    if (TEAM) { if (goal) cloud?.startSession(goal); return; }
    if (!goal || swarm?.running) return;
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

  if (TEAM) win.webContents.once('did-finish-load', startTeamMode);
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  await swarm?.shutdown();
  await cloud?.shutdown();
});
app.on('window-all-closed', () => app.quit());
