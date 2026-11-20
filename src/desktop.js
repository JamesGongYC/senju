// Small pieces of desktop-control logic shared by solo mode (the Swarm) and team mode (the ToolHost).

// What an agent's card says while it holds an action for the user.
export const WAIT_LABEL = 'waiting while you type';

// Desktop tools that only look. They never wait for the user.
export const READ_ONLY = /(^|_)(get|list|read|state|screenshot|snapshot|inspect|find|see|describe|doctor|permissions?|status|wait|sleep)(_|$)/i;

// Remember which app window a desktop agent is driving, so its cursor, cards and window slot
// follow it. Tool inputs name it by pid, window id, or app name.
export function noteTarget(agent, input) {
  if (!input || typeof input !== 'object') return;
  const num = (...keys) => { for (const k of keys) if (Number.isInteger(input[k])) return input[k]; return null; };
  const str = (...keys) => { for (const k of keys) if (typeof input[k] === 'string' && input[k].trim()) return input[k].trim(); return null; };
  const pid = num('pid', 'process_id', 'processId');
  const windowId = num('window_id', 'windowId');
  const app = str('app', 'app_name', 'appName', 'application', 'bundle_id', 'bundleId');
  if (pid == null && windowId == null && !app) return;
  const prev = agent.target ?? {};
  const samePid = pid == null || pid === prev.pid;
  agent.target = {
    pid: pid ?? prev.pid ?? null,
    windowId: windowId ?? (samePid ? prev.windowId ?? null : null),
    app: app ?? (samePid ? prev.app ?? null : null),
  };
}

// Is the user typing or clicking right now? Input an agent itself just produced does not count.
export function userActive(idleSeconds, lastAgentAction, threshold = 2) {
  if (idleSeconds == null) return false;
  if (idleSeconds >= threshold) return false;
  return (Date.now() - lastAgentAction) / 1000 > idleSeconds + 1.5;
}

// Desktop actions that touch the whole Mac whatever app they name: the real pointer, the clipboard,
// which app is in front, or a script that could do any of it.
export const GLOBAL = /^(move_cursor|drag|clipboard_write|bring_to_front|launch_app|activate_app|open_app|focus_window|run_script)$/;

const named = (input) => input && typeof input === 'object' && ['pid', 'process_id', 'processId', 'window_id', 'windowId', 'app', 'app_name', 'appName', 'application', 'bundle_id', 'bundleId'].some((k) => input[k] != null && input[k] !== '');

/**
 * Would this desktop action get in the way of someone typing in the app in front?
 * Yes when it aims at that app, has to run in the foreground, affects the whole Mac, or names no app
 * (its keys would go to whatever is in front). Background actions on another app go ahead.
 * When it cannot tell (the front app is unknown, the target is unclear), it says yes.
 * @param {string} tool
 * @param {object} input  the tool call's arguments
 * @param {{pid?: number, app?: string}|null} target  the app the agent is driving (see noteTarget)
 * @param {{pid?: number, app?: string}|null} front  the app the user is in
 */
export function collides(tool, input, target, front) {
  if (tool === 'run_steps' && Array.isArray(input?.steps)) return steps(input).some((st) => collides(st.tool, st.args, target, front));
  if (!inBackground(tool, input)) return true;
  if (!front) return true;
  const pid = Number.isInteger(input.pid) ? input.pid : target?.pid;
  if (pid != null && front.pid != null) return pid === front.pid;
  const app = (typeof input.app === 'string' ? input.app : target?.app) ?? '';
  if (app && front.app) return app.trim().toLowerCase() === String(front.app).trim().toLowerCase();
  return true;
}

// Does this action stay out of the user's keyboard and pointer: it names an app and is delivered to it
// in the background? Such input is not the user's, and it never shows up as them typing.
export function inBackground(tool, input) {
  if (tool === 'run_steps' && Array.isArray(input?.steps)) return steps(input).every((st) => inBackground(st.tool, st.args));
  if (GLOBAL.test(tool)) return false;
  if (input?.delivery_mode === 'foreground' || input?.foreground === true) return false;
  return named(input);
}

// The steps of a run_steps batch that act, each with the batch's pid if it names none itself.
function steps(input) {
  return input.steps.map((step) => {
    const tool = String(step?.tool ?? step?.name ?? '');
    const args = step?.args ?? step?.arguments ?? {};
    return { tool, args: named(args) || input.pid == null ? args : { ...args, pid: input.pid } };
  }).filter((st) => !READ_ONLY.test(st.tool));
}
