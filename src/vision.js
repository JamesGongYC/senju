// Seeing and acting by sight in a browser window: for what is drawn rather than built from page elements (a canvas
// game, a map, a chart, a drawing, a video frame), which a snapshot cannot describe and browser_click cannot aim at.
//
// browser_look gives the worker a picture of the page (or, zoomed in, of one area of it), sized so the model
// reads it at full detail and quickly: a JPEG at most MAX_EDGE px on its long side, never one the API would
// shrink again, since then the positions the model reads off it would no longer be the page's.
// browser_click_at takes positions in that picture, moves the ghost cursor to each and clicks (or drags), waits for
// the page to react and come to rest, and returns the new picture with the clicks marked: one model step per
// move instead of one to act and another to look.
//
// Pictures are taken through Chrome itself (Page.captureScreenshot, which can crop and scale), from inside the
// Playwright server (browser_run_code_unsafe, which agents never get).
import { toScreen, evalResult, POINT_LEAD_MS } from './point.js';

export const MAX_EDGE = 1400;    // the picture's long side, in px
export const MAX_ZOOM = 3;       // a zoomed-in area is enlarged at most this much
export const ZOOM_EDGE = 1000;   // ... and to at most this many px on its long side
const QUALITY = 72;              // JPEG quality of the picture the model gets
const COMPARE_EDGE = 480;        // frames compared to see the page change are this small
export const WAIT_CHANGE_MS = 1500;   // how long to wait for the page to start reacting
export const SETTLE_MS = 400;         // how long it must hold still before the picture is taken
const MAX_WAIT_MS = 30_000;
const MAX_POINTS = 12;

export const LOOK_TOOL = {
  name: 'browser_look',
  description: 'See the page as a picture. Use it for what is drawn rather than built from page elements (a canvas game or board, a map, a chart, a drawing, a video frame), or to check how the page really looks. Returns the visible page, or with region one area of it enlarged so small details are readable; the pictures browser_click_at returns afterwards stay on that area, so when you work in one part of the page (a game board, a map) look at that part: smaller pictures are faster, and what moves elsewhere on the page (ads, videos) is left out. Positions in the picture (x to the right, y down, in its pixels, from its top-left corner) are what browser_click_at and region take. For ordinary pages prefer browser_snapshot and browser_click: they are exact and cheaper.',
  inputSchema: {
    type: 'object',
    properties: {
      region: {
        type: 'object',
        description: 'Zoom in: the area to look at, in pixels of the picture you last got (the whole visible page if you have none yet)',
        properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
        required: ['x', 'y', 'width', 'height'],
      },
    },
  },
};

export const CLICK_AT_TOOL = {
  name: 'browser_click_at',
  description: 'Click or drag at positions in the picture browser_look last gave you, then get the picture as it is afterwards. Your cursor goes to each position in turn, so several positions in one call are fine and faster (a piece and then where it goes; several cells). It waits for the page to react and hold still before taking the new picture, and small pink rings in it show where your clicks landed, so you can see whether you hit what you meant: one call per move, with no separate look. For a real page element (a button, a link, a field) use browser_click with its ref instead.',
  inputSchema: {
    type: 'object',
    properties: {
      points: {
        type: 'array', minItems: 1, maxItems: MAX_POINTS,
        description: 'Where to click, in order, in pixels of the picture you last got: the centre of each thing you mean to hit',
        items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
      },
      drag: { type: 'boolean', description: 'Press at the first position, move through the others and release at the last (drag and drop, a slider, drawing a line), instead of clicking each' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Default left' },
      double: { type: 'boolean', description: 'Double-click each position' },
      settle: { type: 'number', description: `Seconds the page must hold still before the new picture is taken (default ${SETTLE_MS / 1000}). Raise it when something answers after a pause: the other side's move in a game, a result that loads` },
      wait: { type: 'number', description: `Seconds to wait for the page to start reacting at all (default ${WAIT_CHANGE_MS / 1000}). If nothing changed by then, the result says so` },
    },
    required: ['points'],
  },
};

export const VISION_TOOLS = [LOOK_TOOL, CLICK_AT_TOOL];
export const canSee = (conn) => Boolean(conn.tools?.some((t) => t.name === 'browser_run_code_unsafe'));

// Shared by the snippets below, which run in the Playwright server. geo: the window and page geometry.
// shot(area, scale, quality): a JPEG (base64) of an area of the visible page, given in CSS px from its top-left.
const SETUP = `
  const cdp = await page.context().newCDPSession(page);
  const geo = await page.evaluate(() => ({ sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight,
    vx: window.visualViewport ? visualViewport.pageLeft : scrollX, vy: window.visualViewport ? visualViewport.pageTop : scrollY }));
  const shot = async (r, scale, quality) => (await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality,
    clip: { x: r.x + geo.vx, y: r.y + geo.vy, width: r.width, height: r.height, scale }, captureBeyondViewport: false })).data;
  const small = (r) => Math.min(1, ${COMPARE_EDGE} / Math.max(r.width, r.height));`;

// The picture of an area (null: the whole visible page), and the frame later pictures are compared with.
const LOOK = (area) => `async (page) => {${SETUP}
  const want = ${JSON.stringify(area)} || { x: 0, y: 0, width: geo.iw, height: geo.ih };
  const x = Math.max(0, Math.min(geo.iw - 8, want.x)), y = Math.max(0, Math.min(geo.ih - 8, want.y));
  const r = { x, y, width: Math.max(8, Math.min(geo.iw - x, want.width)), height: Math.max(8, Math.min(geo.ih - y, want.height)) };
  const long = Math.max(r.width, r.height);
  // The whole page: as it is, shrunk only past the size limit. An area: enlarged for detail, up to ZOOM_EDGE px.
  const scale = ${area ? `long > ${ZOOM_EDGE} ? Math.min(1, ${MAX_EDGE} / long) : Math.min(${MAX_ZOOM}, ${ZOOM_EDGE} / long)` : `Math.min(1, ${MAX_EDGE} / long)`};
  const data = await shot(r, scale, ${QUALITY});
  await cdp.detach().catch(() => {});
  return { data, view: { ...r, scale }, m: geo };
}`;

// The window and page geometry alone (for a click with no picture taken before it).
const GEO = `async (page) => {${SETUP}
  await cdp.detach().catch(() => {});
  return { m: geo };
}`;

// Mouse steps. The first of a call also remembers how the view looks just before it acts, to compare with later.
const MOUSE = (steps, view) => (view === undefined
  ? `async (page) => { ${steps.join(' ')} return true; }`
  : `async (page) => {${SETUP}
  const r = ${JSON.stringify(view)} || { x: 0, y: 0, width: geo.iw, height: geo.ih };
  // Two frames a moment apart: a page that is moving by itself (a video, an animation, an ad) never comes to rest,
  // so waiting for that would only cost time.
  const first = await shot(r, small(r), 40);
  await page.waitForTimeout(90);
  page.__senjuBase = await shot(r, small(r), 40);
  page.__senjuMoving = first !== page.__senjuBase;
  await cdp.detach().catch(() => {});
  ${steps.join(' ')}
  return true;
}`);

// After acting: wait until the view has changed and then held still (or it never changed), mark the clicks, and
// take the picture.
const AFTER = (view, marks, waitMs, settleMs) => `async (page) => {${SETUP}
  const r = ${JSON.stringify(view)} || { x: 0, y: 0, width: geo.iw, height: geo.ih };
  const scale = r.scale || Math.min(1, ${MAX_EDGE} / Math.max(r.width, r.height));
  const base = page.__senjuBase, moving = Boolean(page.__senjuMoving), t0 = Date.now();
  let last = await shot(r, small(r), 40), changed = last !== base, lastChange = Date.now(), settled = false;
  if (moving) {
    // It was already moving before the click: give the click the settle time and take the picture.
    await page.waitForTimeout(${Math.max(settleMs, 600)});
    changed = true;
  } else for (;;) {
    const now = Date.now();
    if (!changed && now - t0 >= ${waitMs}) break;
    if (changed && now - lastChange >= ${settleMs}) { settled = true; break; }
    if (now - t0 >= ${Math.min(MAX_WAIT_MS, waitMs + settleMs + 2500)}) break;
    await page.waitForTimeout(110);
    const f = await shot(r, small(r), 40);
    if (f !== last) { last = f; lastChange = Date.now(); changed = true; }
  }
  const waited = Date.now() - t0;
  await page.evaluate((marks) => {
    for (const p of marks) {
      const d = document.createElement('div');
      d.setAttribute('data-senju-mark', '1');
      const s = d.style;
      s.position = 'fixed'; s.left = (p.x - 11) + 'px'; s.top = (p.y - 11) + 'px'; s.width = '18px'; s.height = '18px';
      s.border = '2px solid #ff1fc7'; s.borderRadius = '50%'; s.boxShadow = '0 0 0 1px #fff'; s.pointerEvents = 'none'; s.zIndex = '2147483647';
      document.documentElement.appendChild(d);
    }
  }, ${JSON.stringify(marks)}).catch(() => {});
  const data = await shot(r, scale, ${QUALITY});
  await page.evaluate(() => document.querySelectorAll('[data-senju-mark]').forEach((e) => e.remove())).catch(() => {});
  page.__senjuBase = null;
  await cdp.detach().catch(() => {});
  return { data, changed, settled, moving, waited, view: { ...r, scale }, m: geo };
}`;

async function run(conn, code, signal) {
  const res = await conn.client.callTool({ name: 'browser_run_code_unsafe', arguments: { code } }, undefined, { signal, timeout: 60_000 });
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (res.isError) throw new Error(text.slice(0, 400));
  const value = evalResult(text);
  if (value == null) throw new Error('The browser returned nothing.');
  return value;
}
const sleep = (ms, signal) => new Promise((resolve) => {
  if (ms <= 0 || signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const error = (text) => ({ content: [{ type: 'text', text }], isError: true });

// What the picture shows, in words the model can act on.
function caption(view) {
  const w = Math.round(view.width * view.scale), h = Math.round(view.height * view.scale);
  const whole = view.whole ? 'the whole visible page' : `the page area from (${Math.round(view.x)}, ${Math.round(view.y)}), ${Math.round(view.width)}×${Math.round(view.height)} px${view.scale > 1.01 ? `, enlarged ×${view.scale.toFixed(2).replace(/\.?0+$/, '')}` : ''}`;
  return `The picture is ${w}×${h} px and shows ${whole}. Give positions to browser_click_at and regions to browser_look in this picture's pixels.`;
}
const image = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
// A position in the picture the worker last got -> CSS px in the visible page.
const toPage = (view, p) => (view ? { x: view.x + p.x / view.scale, y: view.y + p.y / view.scale } : p);

/** browser_look: a picture of the visible page, or of one area of it enlarged. */
export async function look(conn, args, signal) {
  if (!canSee(conn)) return error('This browser cannot take pictures of the page. Use browser_take_screenshot.');
  conn.inflight = (conn.inflight ?? 0) + 1;
  try {
    let area = null;
    if (conn.viewStale) { conn.view = null; conn.viewM = null; }   // a region is then measured on the whole visible page
    const g = args?.region;
    if (g && [g.x, g.y, g.width, g.height].every((v) => num(v) != null) && g.width > 0 && g.height > 0) {
      const from = toPage(conn.view, { x: Number(g.x), y: Number(g.y) });
      const k = conn.view?.scale ?? 1;
      area = { x: from.x, y: from.y, width: Number(g.width) / k, height: Number(g.height) / k };
    }
    const got = await run(conn, LOOK(area), signal);
    conn.view = { ...got.view, whole: !area };
    conn.viewM = got.m;
    conn.viewStale = false;
    return { content: [{ type: 'text', text: caption(conn.view) }, image(got.data)], isError: false };
  } catch (err) {
    return error(`Could not take a picture of the page: ${err?.message ?? err}`);
  } finally { conn.inflight -= 1; }
}

/** browser_click_at: click or drag at positions in the last picture, with the cursor, and return the picture afterwards. */
export async function clickAt(conn, args, emit, signal) {
  if (!canSee(conn)) return error('This browser cannot click by position. Use browser_click with an element ref.');
  const raw = Array.isArray(args?.points) ? args.points : [];
  const points = raw.map((p) => ({ x: num(p?.x), y: num(p?.y) })).filter((p) => p.x != null && p.y != null).slice(0, MAX_POINTS);
  if (!points.length || points.length !== Math.min(raw.length, MAX_POINTS)) return error('Give points as [{ "x": …, "y": … }, …], in pixels of the picture you last got from browser_look.');
  if (conn.viewStale) return error('The page has moved on since your last picture (it navigated, scrolled or was resized), so positions from that picture are no longer right. Look again with browser_look and take positions from the new picture.');
  const view = conn.view ?? null;
  if (view) {
    const w = view.width * view.scale, h = view.height * view.scale;
    const out = points.find((p) => p.x < 0 || p.y < 0 || p.x > w || p.y > h);
    if (out) return error(`(${out.x}, ${out.y}) is outside the picture you last got, which is ${Math.round(w)}×${Math.round(h)} px. Look again with browser_look and take positions from that picture.`);
  }
  const button = ['left', 'right', 'middle'].includes(args?.button) ? args.button : 'left';
  const drag = Boolean(args?.drag) && points.length >= 2;
  const waitMs = Math.max(0, Math.min(20_000, (num(args?.wait) ?? WAIT_CHANGE_MS / 1000) * 1000));
  const settleMs = Math.max(100, Math.min(10_000, (num(args?.settle) ?? SETTLE_MS / 1000) * 1000));
  // The same frame of the page the worker was looking at (not the enlarged scale: that is kept for the picture).
  const frame = view ? { x: view.x, y: view.y, width: view.width, height: view.height, scale: view.scale } : null;
  conn.inflight = (conn.inflight ?? 0) + 1;   // also keeps background helpers (the ad watcher) out until it is done
  try {
    // The window's geometry from the last picture places the cursor at once; without one, ask the page.
    const m = conn.viewM ?? (await run(conn, GEO, signal)).m;
    const css = points.map((p) => toPage(view, p));
    const inPage = css.find((p) => p.x < 0 || p.y < 0 || p.x > m.iw || p.y > m.ih);
    if (inPage) return error('That position is no longer on the visible page (it was scrolled or resized). Look again with browser_look.');
    for (let i = 0; i < css.length && !signal?.aborted; i++) {
      const { x, y } = css[i];
      const point = { verb: 'click', ...toScreen(m, x, y), w: 16, h: 16, inView: true };
      if (emit) { emit(point); await sleep(POINT_LEAD_MS, signal); }
      const at = `${x.toFixed(1)}, ${y.toFixed(1)}`;
      const steps = [];
      if (drag) {
        if (i === 0) steps.push(`await page.mouse.move(${at});`, `await page.mouse.down({ button: '${button}' });`);
        else steps.push(`await page.mouse.move(${at}, { steps: 12 });`, ...(i === css.length - 1 ? [`await page.mouse.up({ button: '${button}' });`] : []));
      } else {
        steps.push(`await page.mouse.move(${at});`, `await page.mouse.click(${at}, { button: '${button}', clickCount: ${args?.double ? 2 : 1} });`);
      }
      await run(conn, MOUSE(steps, i === 0 ? frame : undefined), signal);
    }
    const after = await run(conn, AFTER(frame, css, waitMs, settleMs), signal);
    conn.view = { ...after.view, whole: view ? Boolean(view.whole) : true };
    conn.viewM = after.m;
    const did = drag ? `Dragged through ${css.length} positions` : `Clicked ${css.length === 1 ? 'the position' : `${css.length} positions in order`}`;
    const then = after.moving ? `The page keeps moving by itself (a video, an animation or an ad in view), so this is how it looked ${(after.waited / 1000).toFixed(1)} s after${conn.view.whole ? '. To watch only the part you are working on, look at it with browser_look and a region: the pictures after your clicks then show that part and wait for it alone.' : '; if an answer to your move is not in it yet, raise settle or look again.'}`
      : !after.changed ? `Nothing on the page changed in the ${(after.waited / 1000).toFixed(1)} s after it: the click may have missed, or what it hit does not react. Check the rings in the picture against what you meant to hit.`
      : after.settled ? `The page changed and came to rest after ${(after.waited / 1000).toFixed(1)} s.`
        : `The page changed and was still moving after ${(after.waited / 1000).toFixed(1)} s, so this picture may be mid-change.`;
    return { content: [{ type: 'text', text: `${did}. ${then} Pink rings mark where the clicks landed. ${caption(conn.view)}` }, image(after.data)], isError: false };
  } catch (err) {
    return error(`Could not click there: ${err?.message ?? err}`);
  } finally { conn.inflight -= 1; }
}

/** Tools after which the last picture no longer shows where things are. */
export const MOVES_VIEW = /^browser_(navigate|navigate_back|tabs|resize|scroll)$/;
