// Ghost cursors on what an agent is doing in its browser window.
// Just before a browser action, measure where it lands and emit { type: 'point', agentId, point }, then wait a
// moment so the cursor in the overlay gets there before the action does. Best effort: it never blocks the action.
import { callTool } from './mcp.js';

// Where an element is, as { box, clipped, rect, m }:
// - box: its bounding box in the TOP page's viewport (CSS px), so an element inside an iframe (claude.ai, mail
//   clients, embedded editors) is placed where it really is, not where it sits inside its frame;
// - clipped: whether its centre is hidden, out of its frame's viewport or outside a scrolling container;
// - rect: its top-left inside its own frame (to place scrolling inside a frame);
// - m: the browser window: screen position, outer and inner size (for the tab and address bars and page zoom).
// Measured with Playwright itself (browser_run_code_unsafe, which agents never get) so frames are handled; a
// server without it is measured from inside the page, which is exact for elements not in a frame. No scrolling.
const IN_FRAME = `(el) => {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let clipped = cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight;
  for (let n = el.parentElement; n && !clipped && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (!/auto|scroll|hidden|clip/.test(s.overflowX + s.overflowY)) continue;
    const p = n.getBoundingClientRect();
    if (cx < p.left || cx > p.right || cy < p.top || cy > p.bottom) clipped = true;
  }
  return { clipped, rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
}`;
const METRICS = `() => ({ sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight })`;
const LOCATE = (target) => `async (page) => {
  const t = ${JSON.stringify(String(target))};
  const loc = page.locator(/^(f\\d+)?e\\d+$/.test(t) ? 'aria-ref=' + t : t).first();
  const box = await loc.boundingBox({ timeout: 1500 });
  if (!box) return null;
  const inner = await loc.evaluate(${IN_FRAME}, null, { timeout: 1500 }).catch(() => ({ clipped: false, rect: null }));
  return { box, ...inner, m: await page.evaluate(${METRICS}) };
}`;
const MEASURE = `(el) => {
  const inner = (${IN_FRAME})(el);
  const r = inner.rect;
  return { box: { x: r.left, y: r.top, width: r.width, height: r.height }, ...inner, m: (${METRICS})() };
}`;

// A point in the top page's viewport (CSS px) as the cursor needs it: from the window's top-left in screen points
// (x, y, past the tab and address bars), on the screen (screenX, screenY), the window's size and the bars' height.
// Page zoom (Cmd +/-) scales CSS px to points; on a Mac the page fills the window's width, which gives the zoom.
export function toScreen(m, cssX, cssY) {
  const raw = m.iw > 0 ? m.ow / m.iw : 1;
  const z = raw > 0.3 && raw < 3 && Math.abs(raw - 1) > 0.02 ? raw : 1;
  const side = z === 1 ? Math.max(0, (m.ow - m.iw) / 2) : 0;
  const top = Math.max(0, m.oh - m.ih * z - side);
  const x = Math.round(side + cssX * z), y = Math.round(top + cssY * z);
  return { x, y, screenX: Math.round(m.sx + x), screenY: Math.round(m.sy + y), windowW: m.ow, windowH: m.oh, chromeTop: Math.round(top), z };
}

const canLocate = (conn) => conn.tools?.some((t) => t.name === 'browser_run_code_unsafe');
async function locate(conn, ref, element, signal) {
  const res = canLocate(conn)
    ? await within(callTool(conn, 'browser_run_code_unsafe', { code: LOCATE(ref) }, signal), MEASURE_MAX_MS)
    : await within(callTool(conn, 'browser_evaluate', { element, target: ref, ref, function: MEASURE }, signal), MEASURE_MAX_MS);
  const at = res && !res.isError ? evalResult(text(res)) : null;
  return at?.box && at.m && Number.isFinite(at.box.x) ? at : null;
}

// The cursor's point for an element: its centre, its width in points, and whether it is in view.
function elementPoint(at) {
  const { box, m } = at;
  const p = toScreen(m, box.x + box.width / 2, box.y + box.height / 2);
  const inTop = box.x + box.width / 2 >= 0 && box.y + box.height / 2 >= 0 && box.x + box.width / 2 <= m.iw && box.y + box.height / 2 <= m.ih;
  return { ...p, w: Math.round(box.width * p.z), h: Math.round(box.height * p.z), inView: box.width > 0 && box.height > 0 && inTop && !at.clipped };
}

// Typing that people can watch: the text appears a few letters at a time, at most TYPE_MAX_MS in all, then the
// real browser_type sets it exactly. Field types that cannot hold part of a value are filled at once, and so are
// rich editors (contenteditable: ProseMirror, Lexical, Slate), which keep their own model of the text and can be
// left out of step, or re-render on every letter, when their DOM is written to directly.
export const TYPE_MS_PER_CHAR = 16;
export const TYPE_MAX_MS = 900;
export const typeMs = (chars) => Math.min(TYPE_MAX_MS, Math.max(0, chars) * TYPE_MS_PER_CHAR);
const typeOut = (text) => `async (el) => {
  const text = ${JSON.stringify(text)};
  const kind = (el.getAttribute('type') || 'text').toLowerCase();
  if (el.isContentEditable || !(el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'password', ''].includes(kind)))) return 'skipped';
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  const put = (v) => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  el.focus();
  const steps = Math.max(1, Math.min(text.length, Math.floor(${TYPE_MAX_MS} / ${TYPE_MS_PER_CHAR})));
  for (let i = 1; i <= steps; i++) {
    put(text.slice(0, Math.round((text.length * i) / steps)));
    await new Promise((r) => setTimeout(r, ${TYPE_MS_PER_CHAR}));
  }
  return 'typed';
}`;

// The value from a browser_evaluate reply: the JSON under "### Result".
export function evalResult(text) {
  const m = String(text ?? '').match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/);
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
}

export const POINT_LEAD_MS = 200;   // head start for the cursor's glide (the overlay's glides take 100-190 ms)
const MEASURE_MAX_MS = 2000;
export const pointLeadMs = (point) => (point?.verb === 'key' ? 0 : POINT_LEAD_MS + (point?.verb === 'open' ? Number(point.typeMs) || 0 : 0));

const ELEMENT_VERBS = { browser_click: 'click', browser_hover: 'click', browser_select_option: 'select', browser_type: 'type' };
const text = (res) => (res?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const sleep = (ms, signal) => new Promise((resolve) => {
  if (ms <= 0 || signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
const within = (promise, ms) => { let t; return Promise.race([promise, new Promise((r) => { t = setTimeout(() => r(null), ms); })]).finally(() => clearTimeout(t)); };

/**
 * Call before a Playwright MCP tool runs. Emits the point for that action and waits for the cursor.
 * @param {object} conn       the worker's browser connection
 * @param {string} tool       e.g. browser_click
 * @param {object} args       the tool's input
 * @param {(point: object) => void} emit
 * @param {AbortSignal} [signal]
 */
export async function pointBefore(conn, tool, args, emit, signal) {
  try {
    let point = null;
    const ref = args?.target ?? args?.ref;
    if (ELEMENT_VERBS[tool] && ref) {
      const verb = ELEMENT_VERBS[tool];
      const element = String(args.element ?? 'element');
      let found = await locate(conn, ref, element, signal);
      if (!found) return;
      let at = elementPoint(found);
      // Out of view: the cursor scrolls the page to it first, as a person would, instead of the page jumping.
      if (at.inView === false && at.w > 0 && at.h > 0) {
        const scrolled = await scrollWithCursor(conn, { target: ref, element }, emit, signal, found);
        if (scrolled?.moved) { found = (await locate(conn, ref, element, signal)) ?? found; at = elementPoint(found); }
      }
      const typed = verb === 'type' ? String(args.text ?? '') : '';
      point = { verb, ...at, ...(verb === 'type' ? { chars: typed.length, typeMs: typeMs(typed.length) } : {}) };
      emit(point);
      await sleep(pointLeadMs(point), signal);
      if (typed && !args.slowly) {
        // Let people watch it type; browser_type still sets the exact text and fires the real events.
        await within(callTool(conn, 'browser_evaluate', { element, target: ref, ref, function: typeOut(typed) }, signal).catch(() => null), TYPE_MAX_MS + 1500);
      }
      return;
    }
    if (tool === 'browser_navigate' && args?.url) point = { verb: 'open', url: String(args.url), typeMs: typeMs(String(args.url).length) };
    else if (tool === 'browser_navigate_back') point = { verb: 'back' };
    else if (tool === 'browser_press_key') point = { verb: 'key', key: String(args?.key ?? '') };
    if (!point) return;
    emit(point);
    await sleep(pointLeadMs(point), signal);
  } catch { /* the action still runs */ }
}

// ---- Scrolling with the cursor ----------------------------------------------------------------------------
// browser_scroll, a tool of the app's own for browser workers: the ghost cursor moves onto the area that will
// scroll, then the page scrolls smoothly under it, so the person sees what moved and why. The same is done
// before a click or entry on an element that is out of view.

export const SCROLL_TOOL = {
  name: 'browser_scroll',
  description: 'Scroll the page, or one scrollable area of it, with the cursor, the way a person uses the mouse wheel. Use this for every scroll: to see more of a page, load more results, or bring something into view. Never scroll with browser_evaluate. Give direction to scroll by screens; give target (a ref from the snapshot) without direction to scroll until that element is in view; give both to scroll the panel or list that contains target (a side panel, a chat history, a dropdown). Clicking or typing into an element out of view scrolls to it by itself, so there is no need to scroll first for that.',
  input_schema: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['down', 'up', 'left', 'right'], description: 'Which way to scroll. Leave out, with target, to scroll target into view.' },
      pages: { type: 'number', description: 'How far, in screens of the scrolled area (default 1; 0.5 for half a screen, up to 10).' },
      element: { type: 'string', description: 'Human-readable description of target, if target is given.' },
      target: { type: 'string', description: 'Exact ref of an element from the page snapshot.' },
    },
  },
};

// Runs in the page (on target if one is given). Picks what will scroll, marks it, and says where the cursor goes:
// the centre of that area's visible part, in the same window coordinates as MEASURE.
const SCROLL_PLAN = (direction, pages) => `(el) => {
  const dir = ${JSON.stringify(direction ?? null)}, pages = ${Number(pages) || 1};
  if (!el && !dir) return { error: 'Give a direction, or a target to scroll into view.' };
  const axis = dir === 'left' || dir === 'right' ? 'x' : 'y';
  const root = document.scrollingElement || document.documentElement;
  const roomIn = (n, a) => a === 'y' ? n.scrollHeight - n.clientHeight : n.scrollWidth - n.clientWidth;
  const scrolls = (n, a) => {
    if (!n || n.nodeType !== 1 || roomIn(n, a) < 2) return false;
    return /auto|scroll|overlay/.test(getComputedStyle(n)[a === 'y' ? 'overflowY' : 'overflowX']);
  };
  const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  const pageScrolls = roomIn(root, axis) > 2 && getComputedStyle(document.body)[axis === 'y' ? 'overflowY' : 'overflowX'] !== 'hidden';
  const start = el || document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  let box = null;
  for (let n = start, hops = 0; n && n !== document.body && n !== root && hops < 60; n = up(n), hops++) if (scrolls(n, axis)) { box = n; break; }
  // An app whose page does not scroll keeps its scroller somewhere else (a chat, a mail list): take the biggest one.
  if (!box && !pageScrolls && !el) {
    let best = 0;
    for (const n of document.querySelectorAll('*')) { if (!scrolls(n, axis)) continue; const r = n.getBoundingClientRect(); if (r.width * r.height > best) { best = r.width * r.height; box = n; } }
  }
  if (!box && !pageScrolls) return { error: 'Nothing here can scroll.' };
  const r = box ? box.getBoundingClientRect() : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const vl = Math.max(0, r.left), vt = Math.max(0, r.top), vr = Math.min(innerWidth, r.right), vb = Math.min(innerHeight, r.bottom);
  document.querySelectorAll('[data-senju-scroll]').forEach((n) => n.removeAttribute('data-senju-scroll'));
  if (box) box.setAttribute('data-senju-scroll', '1');
  let toward = dir;
  if (el && !dir) {
    const e = el.getBoundingClientRect();
    if (e.width === 0 && e.height === 0) return { error: 'That element is not shown on the page.' };
    if (e.top >= vt && e.bottom <= vb && e.left >= vl && e.right <= vr) return { inView: true };
    toward = e.top < vt ? 'up' : e.bottom > vb ? 'down' : e.left < vl ? 'left' : 'right';
  }
  const span = axis === 'y' ? vb - vt : vr - vl;
  const er = el ? el.getBoundingClientRect() : null;
  return { cx: (vl + vr) / 2, cy: vt + (vb - vt) * 0.55, el: er ? { left: er.left, top: er.top } : null, m: (${METRICS})(),
    dir: toward, toView: Boolean(el && !dir), delta: Math.round(Math.min(10, Math.max(0.1, pages)) * span * 0.85), page: !box };
}`;

// Runs in the page: scroll the marked area (or the page) smoothly, wait for it to come to rest, and report.
const SCROLL_RUN = (plan) => `async (el) => {
  const root = document.scrollingElement || document.documentElement;
  const box = document.querySelector('[data-senju-scroll]') || root;
  box.removeAttribute('data-senju-scroll');
  const before = { top: box.scrollTop, left: box.scrollLeft };
  const d = ${Number(plan.delta) || 0}, dir = ${JSON.stringify(plan.dir)};
  const done = new Promise((resolve) => {
    let over = false; const end = () => { if (!over) { over = true; resolve(); } };
    (box === root ? document : box).addEventListener('scrollend', end, { once: true });
    setTimeout(() => { if (box.scrollTop === before.top && box.scrollLeft === before.left) end(); }, 160);
    setTimeout(end, 1200);
  });
  if (${plan.toView ? 'true' : 'false'} && el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  else box.scrollBy({ top: dir === 'down' ? d : dir === 'up' ? -d : 0, left: dir === 'right' ? d : dir === 'left' ? -d : 0, behavior: 'smooth' });
  await done;
  const y = dir === 'up' || dir === 'down';
  const pos = Math.round(y ? box.scrollTop : box.scrollLeft), max = Math.round(y ? box.scrollHeight - box.clientHeight : box.scrollWidth - box.clientWidth);
  return { moved: Math.abs(box.scrollTop - before.top) + Math.abs(box.scrollLeft - before.left) >= 1, pos, max };
}`;

export const SCROLL_MS = 450;   // how long the overlay plays the scroll gesture
const say = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError });

/**
 * Scroll with the ghost cursor. args: browser_scroll's input ({ direction?, pages?, target?, element? }).
 * Returns a tool result with .moved set when anything scrolled. Never throws.
 */
export async function scrollWithCursor(conn, args, emit, signal, known = null) {
  try {
    const ref = args?.target ?? args?.ref;
    const element = String(args?.element ?? 'The element');
    const on = ref ? { element, target: ref, ref } : {};
    const planned = await within(callTool(conn, 'browser_evaluate', { ...on, function: SCROLL_PLAN(args?.direction, args?.pages) }, signal), MEASURE_MAX_MS);
    if (!planned) return say('Could not scroll: the page did not answer in time.', true);
    if (planned.isError) return planned;
    const plan = evalResult(text(planned));
    if (!plan) return say('Could not scroll here.', true);
    if (plan.error) return say(`Not scrolled: ${plan.error}`, true);
    if (plan.inView) return { ...say(`${element} is already in view.`), moved: false };
    // The plan is in its frame's own coordinates. In a frame, where the target really is on the page gives the
    // frame's offset (and the window's metrics come from the top page).
    let dx = 0, dy = 0, m = plan.m;
    if (ref && plan.el) {
      const at = known ?? await locate(conn, ref, element, signal);
      if (at?.box && at.m) { dx = at.box.x - plan.el.left; dy = at.box.y - plan.el.top; m = at.m; }
    }
    if (Number.isFinite(plan.cx) && m) {
      emit({ verb: 'scroll', ...toScreen(m, plan.cx + dx, plan.cy + dy), dir: plan.dir, ms: SCROLL_MS });
      await sleep(POINT_LEAD_MS, signal);
    }
    const ran = await within(callTool(conn, 'browser_evaluate', { ...on, function: SCROLL_RUN(plan) }, signal), MEASURE_MAX_MS + 1500);
    const out = ran && !ran.isError ? evalResult(text(ran)) : null;
    if (!out) return { ...say('Scrolled, but could not read where the page ended up.'), moved: true };
    const what = plan.page ? 'The page' : 'That area';
    const edge = plan.dir === 'down' ? 'bottom' : plan.dir === 'up' ? 'top' : `${plan.dir} edge`;
    if (!out.moved) return { ...say(plan.toView ? `Could not scroll ${element} into view.` : `${what} did not move: it is already at the ${edge}.`), moved: false };
    const where = out.pos <= 0 ? 'at the start' : out.pos >= out.max - 1 ? `at the ${edge}` : `${out.max > 0 ? Math.round((out.pos / out.max) * 100) : 100}% of the way`;
    const head = plan.toView ? `Scrolled ${plan.dir} until ${element} is in view.` : `Scrolled ${plan.dir}.`;
    return { ...say(`${head} ${what} is now ${where} (${out.pos} of ${out.max} px). Anything that loaded as it scrolled shows in browser_snapshot.`), moved: true };
  } catch (err) {
    return say(`Could not scroll: ${err?.message ?? err}`, true);
  }
}

// ---- Reading, shown --------------------------------------------------------------------------------------------
// When a worker reads a page (opening it, a snapshot), the cursor skims the text, and on a page longer than the
// window the page scrolls down under it as it reads, then back to where it was. It runs while the model thinks
// about what it read, so it costs no time; the worker's next action on that window waits for it to finish
// (conn.reading), and the page is left exactly as it was found. Each page is read this way once.

const READ_PLAN = `() => {
  const root = document.scrollingElement || document.documentElement;
  const room = root.scrollHeight - innerHeight;
  const bodyScrolls = getComputedStyle(document.body).overflowY !== 'hidden' && getComputedStyle(root).overflowY !== 'hidden';
  return { url: location.href, y0: root.scrollTop, room: bodyScrolls ? Math.max(0, room - root.scrollTop) : 0, ih: innerHeight, iw: innerWidth, m: (${METRICS})() };
}`;
const READ_RUN = (down, y0) => `async () => {
  const root = document.scrollingElement || document.documentElement;
  const rest = (ms) => new Promise((resolve) => { let done = false; const end = () => { if (!done) { done = true; resolve(); } }; document.addEventListener('scrollend', end, { once: true }); setTimeout(end, ms); });
  root.scrollBy({ top: ${Math.round(down)}, behavior: 'smooth' });
  await rest(900);
  await new Promise((r) => setTimeout(r, 220));
  root.scrollTo({ top: ${Math.round(y0)}, behavior: 'smooth' });
  await rest(900);
  if (Math.abs(root.scrollTop - ${Math.round(y0)}) > 2) root.scrollTo({ top: ${Math.round(y0)} });
  return root.scrollTop;
}`;
export const READ_MS = 1300;      // a skim with scrolling; a skim alone takes SKIM_MS
export const SKIM_MS = 650;

/**
 * Show the worker reading its page. scroll: false only skims (after a screenshot or a script that reads).
 * Returns a promise for when the page is back as it was; never rejects.
 */
export function readPage(conn, emit, { scroll = true } = {}) {
  const run = (async () => {
    const planned = await within(callTool(conn, 'browser_evaluate', { function: READ_PLAN }), MEASURE_MAX_MS);
    const plan = planned && !planned.isError ? evalResult(text(planned)) : null;
    if (!plan?.m) return;
    const tl = toScreen(plan.m, 0, 0), br = toScreen(plan.m, plan.iw, plan.ih);
    const rect = { screenX: tl.screenX, screenY: tl.screenY, w: br.screenX - tl.screenX, h: br.screenY - tl.screenY };
    const seen = (conn.readPages ??= new Set());
    const scrolls = scroll && plan.room > plan.ih * 0.4 && !seen.has(plan.url);
    seen.add(plan.url);
    emit({ verb: 'read', rect, ms: scrolls ? READ_MS : SKIM_MS });
    if (scrolls) await within(callTool(conn, 'browser_evaluate', { function: READ_RUN(Math.min(plan.room, plan.ih * 1.5), plan.y0) }), 3000);
  })().catch(() => {});
  conn.reading = run;
  run.finally(() => { if (conn.reading === run) conn.reading = null; });
  return run;
}
