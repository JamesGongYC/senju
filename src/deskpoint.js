// Desktop apps (through cua-driver): make a launched app's window visible, and point the agent's ghost cursor
// at the element or spot each desktop action lands on. Best effort: never blocks or fails the action.
import { execFile } from 'node:child_process';
import { callTool } from './mcp.js';
import { POINT_LEAD_MS } from './point.js';

const ACTIONS = /^(click|double_click|right_click|type_text|set_value|scroll|press_key|hotkey|drag)$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// get_window_state: ask for element frames too. They come back in structuredContent only, so the model
// reads exactly what it did before.
export function widenWindowState(tool, input) {
  if (tool !== 'get_window_state' || !input || typeof input !== 'object') return input;
  return input.tree_format && input.tree_format !== 'markdown' ? input : { ...input, tree_format: 'both' };
}

// Remember where every element of the latest snapshot sits on screen, and the window's frame and scale.
export function rememberFrames(agent, tool, res) {
  if (tool !== 'get_window_state' || !res?.structured) return;
  const sc = res.structured;
  agent.deskFrames ??= new Map();
  for (const e of sc.elements ?? []) if (e.element_token && e.frame) agent.deskFrames.set(e.element_token, e.frame);
  if (sc.window_id && sc.window_bounds) {
    agent.deskWindows ??= new Map();
    agent.deskWindows.set(sc.window_id, { bounds: sc.window_bounds, scale: sc.screenshot_scale || 1 });
  }
}

// Before an action: the screen point it lands on, or null.
export function deskPoint(agent, tool, input) {
  if (!ACTIONS.test(tool) || !input) return null;
  const verb = /type|set_value/.test(tool) ? 'type' : tool === 'press_key' || tool === 'hotkey' ? 'key' : tool === 'scroll' ? 'scroll' : 'click';
  const extra = verb === 'scroll' ? { dir: input.direction ?? 'down', ms: 450 } : {};
  const f = input.element_token ? agent.deskFrames?.get(input.element_token) : null;
  if (f) return { verb, screenX: Math.round(f.x + f.w / 2), screenY: Math.round(f.y + f.h / 2), w: f.w, chars: String(input.text ?? input.value ?? '').length, ...extra };
  if (Number.isFinite(input.x) && Number.isFinite(input.y) && input.window_id != null) {
    const win = agent.deskWindows?.get(input.window_id);
    if (win) return { verb, screenX: Math.round(win.bounds.x + input.x / win.scale), screenY: Math.round(win.bounds.y + input.y / win.scale), ...extra };
  }
  // A keystroke scroll (no target) scrolls the window the agent is in: play it where the cursor already is.
  if (verb === 'scroll') return { verb: 'key' };
  return verb === 'key' ? { verb: 'key' } : null;
}

export async function pointDesk(agent, tool, input, emit) {
  const p = deskPoint(agent, tool, input);
  if (!p) return;
  emit(p);
  if (p.verb !== 'key') await sleep(POINT_LEAD_MS);
}

const windowsOf = async (conn, pid) => ((await callTool(conn, 'list_windows', { pid }))?.structured?.windows ?? [])
  .filter((w) => w.layer === 0 && w.bounds?.width > 60 && w.bounds?.height > 60);
const visible = (w) => w && w.is_on_screen && w.on_current_space !== false;
const openApp = (app) => new Promise((resolve) => execFile('/usr/bin/open', ['-a', app], { timeout: 5000 }, () => resolve()));

// Bring an app's window onto the screen the person is looking at: the driver's bring_to_front first, then
// macOS itself (open -a), which switches to the app's desktop Space. Returns { windowId, note }.
export async function reveal(conn, pid, preferId = null, force = false) {
  let wins = await windowsOf(conn, pid);
  let w = wins.find((x) => x.window_id === preferId) ?? wins.find((x) => x.title) ?? wins[0];
  if (!w) return { windowId: null, note: '' };
  if (visible(w) && !force) return { windowId: w.window_id, note: '' };
  // Take the person to the app: macOS brings it to the front and switches to its desktop Space if needed.
  if (force && w.app_name) { await openApp(w.app_name); await sleep(700); wins = await windowsOf(conn, pid); const n = wins.find((x) => x.window_id === w.window_id); if (visible(n)) return { windowId: n.window_id, note: `\n${w.app_name} is now in front on the person's screen (window_id ${n.window_id}).` }; }
  await callTool(conn, 'bring_to_front', { pid, window_id: w.window_id }).catch(() => null);
  wins = await windowsOf(conn, pid);
  let now = wins.find((x) => x.window_id === w.window_id);
  if (!visible(now) && w.app_name) {
    await openApp(w.app_name);
    await sleep(900);
    wins = await windowsOf(conn, pid);
    now = wins.find((x) => x.window_id === w.window_id) ?? wins.find(visible);
  }
  if (!visible(now)) return { windowId: w.window_id, note: `\nThe ${w.app_name ?? 'app'} window could not be brought onto the person's screen (it is on another desktop or full-screen Space). Ask the person to switch to it, with ask_user, if actions keep failing.` };
  return { windowId: now.window_id, note: `\n${w.app_name ?? 'The app'}'s window was on another desktop or hidden, so it was brought onto the person's screen (window_id ${now.window_id}). Read it again with get_window_state before acting.` };
}

// After launch_app: show the app's main window so the person sees it open. Returns { pid, windowId, note }.
export async function showLaunched(conn, res) {
  const text = (res?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const pid = Number(text.match(/\(pid (\d+)\)/)?.[1]);
  if (!pid) return null;
  try { return { pid, ...(await reveal(conn, pid, null, true)) }; } catch { return { pid, windowId: null, note: '' }; }
}

// A desktop action refused because its window is on another Space or not on screen.
export const OFF_SPACE = /off_space|not among the process's current AXWindows|Needs a visible window|not on screen|other Space/i;

// After a desktop action: read the window it acted on, so the worker sees the result in the same tool result
// instead of spending another model turn on get_window_state (the driver's own advice: act and observe in one
// call). The app's window list is checked too, so a window that closed or opened is said plainly instead of
// the worker being shown a stale picture. Returns { res, note } or null when there is no window to read.
export const ACTS = ACTIONS;
export async function lookAfter(conn, agent, signal) {
  const pid = agent.target?.pid;
  if (!Number.isInteger(pid)) return null;
  try {
    const wins = (await callTool(conn, 'list_windows', { pid }, signal))?.structured?.windows?.filter((w) => w.pid === pid) ?? [];
    const known = (agent.knownWindows ??= new Map());
    const isNew = (w) => known.has(pid) && !known.get(pid).has(w.window_id);
    let windowId = agent.target?.windowId;
    const notes = [];
    if (wins.length) {
      const stillThere = Number.isInteger(windowId) && wins.some((w) => w.window_id === windowId);
      const fresh = wins.filter(isNew);
      if (!stillThere) {
        const next = fresh[0] ?? wins.find((w) => w.on_current_space && w.is_on_screen) ?? wins[0];
        if (Number.isInteger(windowId)) notes.push(`The window you were working in (window_id ${windowId}) is no longer open. This is "${next.title ?? ''}" (window_id ${next.window_id}).`);
        windowId = next.window_id;
      } else if (fresh.length) {
        notes.push(`New window${fresh.length > 1 ? 's' : ''} opened in this app: ${fresh.map((w) => `"${w.title ?? ''}" (window_id ${w.window_id})`).join(', ')}. Shown below is still window_id ${windowId}; read the new one with get_window_state if your work moved there.`);
      }
      known.set(pid, new Set(wins.map((w) => w.window_id)));
    }
    if (!Number.isInteger(windowId)) return null;
    agent.target = { ...agent.target, windowId };
    const res = await callTool(conn, 'get_window_state', widenWindowState('get_window_state', { pid, window_id: windowId }), signal);
    if (!res || res.isError) return null;
    rememberFrames(agent, 'get_window_state', res);
    return { res, note: notes.join(' ') };
  } catch { return null; }
}

// ---- Reading an app window, shown -------------------------------------------------------------------------------
// After a worker reads an app window (get_window_state), if text runs past its top or bottom, the window scrolls
// under the resting cursor as a person reads it, through the driver's background scroll (the real pointer never
// moves). Text below: read on down a couple of steps, and stay. Text only above (a chat at its newest message, as in
// the Claude app): scroll up to where the reply starts, then back down by the same distance (the driver reports how
// far each step went), ending where the worker left it, at the input. It plays while the model thinks; the worker's
// next desktop action stops it first (stop()), and a chat is still put back. It only scrolls toward text that is
// out of view: a step with nothing left to scroll is slow to fail.

// Text the window shows only in part: elements cut off at its top or bottom edge come back one point tall there.
// A few always sit at the top (sticky headers), so a handful is not enough to count.
export function textOutOfView(sc) {
  const b = sc?.window_bounds;
  if (!b) return null;
  const text = (sc.elements ?? []).filter((e) => /StaticText|Heading/.test(e.role ?? '') && e.frame);
  const top = b.y, bottom = b.y + b.height;
  const sliver = (e) => e.frame.h <= 2;
  const above = text.filter((e) => (sliver(e) && Math.abs(e.frame.y - top) <= 2) || e.frame.y + e.frame.h < top).length;
  const below = text.filter((e) => (sliver(e) && Math.abs(e.frame.y + e.frame.h - bottom) <= 2) || e.frame.y > bottom).length;
  // Where to scroll: the biggest web or scroll area in the window, cut to the window.
  const areas = (sc.elements ?? []).filter((e) => /AXWebArea|AXScrollArea/.test(e.role ?? '') && e.frame).sort((p, q) => q.frame.w * q.frame.h - p.frame.w * p.frame.h);
  const f = areas[0]?.frame ?? { x: b.x, y: b.y, w: b.width, h: b.height };
  const l = Math.max(f.x, b.x), r = Math.min(f.x + f.w, b.x + b.width), t = Math.max(f.y, top), d = Math.min(f.y + f.h, bottom);
  return { above, below, spot: { x: Math.round((l + r) / 2), y: Math.round(t + (d - t) * 0.55) }, bounds: b, scale: sc.screenshot_scale || 1, pid: sc.pid, windowId: sc.window_id };
}

export const DESK_READ_STEPS = 2;
export const DESK_READ_PAUSE_MS = 450;
const MANY = 4;   // more cut-off lines than this at an edge: there is text beyond it

/**
 * Show reading an app window. turn(fn) runs fn in the desktop server's queue; busy() says to stop (the person
 * started typing, or the job ended). Returns { done, stop }; done never rejects.
 */
export function readWindow(conn, sc, emit, { turn = (fn) => fn(), busy = () => false } = {}) {
  let stopped = false, wake = null;
  const stop = () => { stopped = true; wake?.(); };
  const pause = (ms) => (stopped ? null : new Promise((r) => { wake = r; setTimeout(r, ms); }));
  const done = (async () => {
    const at = textOutOfView(sc);
    if (!at || !Number.isInteger(at.pid) || at.windowId == null) return;
    const x = Math.round((at.spot.x - at.bounds.x) * at.scale), y = Math.round((at.spot.y - at.bounds.y) * at.scale);
    const step = async (direction) => {
      if (busy()) return 0;
      emit({ verb: 'scroll', screenX: at.spot.x, screenY: at.spot.y, dir: direction, ms: 450 });
      await sleep(POINT_LEAD_MS);
      const res = await turn(() => callTool(conn, 'scroll', { pid: at.pid, window_id: at.windowId, x, y, direction, amount: 6, post_action_wait: 'none' }));
      if (!res || res.isError) return 0;
      const said = (res.content ?? []).map((c) => c.text ?? '').join(' ');
      return Number(said.match(/about (\d+) ?pt/)?.[1]) || (/scrolled/i.test(said) ? 1 : 0);
    };
    if (at.below > MANY) {
      for (let i = 0; i < DESK_READ_STEPS && !stopped; i++) {
        await pause(DESK_READ_PAUSE_MS);
        if (stopped || !(await step('down'))) break;
      }
    } else if (at.above > MANY) {
      let net = 0;
      for (let i = 0; i < DESK_READ_STEPS && !stopped; i++) {
        await pause(120);
        if (stopped) break;
        const moved = await step('up');
        if (!moved) break;
        net += moved;
      }
      // Back down to where it was, even when stopped (then without the pauses to read).
      for (let i = 0; net > 0 && i < DESK_READ_STEPS + 3; i++) {
        await pause(DESK_READ_PAUSE_MS);
        const moved = await step('down');
        if (!moved) break;
        net -= moved;
      }
    }
  })().catch(() => {});
  return { done, stop };
}
