// Seeing and clicking by sight, in a real headless browser: the picture's size, clicks landing on the exact page
// position (also from a zoomed-in picture and on a scrolled page), several clicks and a drag in one call, the
// cursor shown for each, and waiting for the page to react before the picture comes back.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectServer, callTool, buildToolset } from '../src/mcp.js';
import { look, clickAt, canSee, MAX_EDGE, VISION_TOOLS } from '../src/vision.js';
import { evalResult, SCROLL_TOOL } from '../src/point.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A canvas that records every click and drag in page coordinates, and repaints a moment after each click.
const page = `<!doctype html><body style="margin:0">
<canvas id="c" width="900" height="600" style="display:block;background:#234"></canvas><div style="height:1500px"></div>
<script>
  window.hits = []; window.drags = [];
  const g = c.getContext('2d');
  c.addEventListener('click', (e) => { hits.push([e.clientX, e.clientY, e.button]); setTimeout(() => { g.fillStyle = '#fc0'; g.fillRect(e.offsetX - 20, e.offsetY - 20, 40, 40); }, 250); });
  c.addEventListener('contextmenu', (e) => { e.preventDefault(); hits.push([e.clientX, e.clientY, 2]); });
  let down = null;
  c.addEventListener('mousedown', (e) => { down = [e.clientX, e.clientY]; });
  c.addEventListener('mouseup', (e) => { if (down && (down[0] !== e.clientX || down[1] !== e.clientY)) drags.push([...down, e.clientX, e.clientY]); down = null; });
</script></body>`;
const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(page); }).listen(0);
const conn = await connectServer('browser', { command: process.execPath, args: [path.join(root, 'node_modules/@playwright/mcp/cli.js'), '--headless', '--isolated'] });
assert.ok(canSee(conn));
await callTool(conn, 'browser_navigate', { url: `http://127.0.0.1:${srv.address().port}/` });
const value = async (fn) => evalResult((await callTool(conn, 'browser_evaluate', { function: fn })).content.map((c) => c.text).join('\n'));
// Width and height of a JPEG, from its frame header.
const jpegSize = (b64) => { const b = Buffer.from(b64, 'base64'); for (let i = 2; i < b.length;) { const m = b[i + 1]; if (m >= 0xc0 && m <= 0xc3) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; i += 2 + b.readUInt16BE(i + 2); } return null; };
const pic = (res) => res.content.find((c) => c.type === 'image');
const said = (res) => res.content.find((c) => c.type === 'text').text;

// Looking: a JPEG of the visible page, one picture pixel per page pixel (the page is under the size limit).
const vp = await value('() => [innerWidth, innerHeight]');
let res = await look(conn, {});
assert.equal(res.isError, false, said(res));
assert.equal(pic(res).source.media_type, 'image/jpeg');
const size = jpegSize(pic(res).source.data);
assert.ok(Math.abs(size[0] - vp[0]) <= 1 && Math.abs(size[1] - vp[1]) <= 1, `picture ${size} for a page of ${vp}`);
assert.ok(Math.max(...size) <= MAX_EDGE);
assert.match(said(res), /whole visible page/);
assert.ok(pic(res).source.data.length < 400_000, 'a compact picture');

// Clicking a position in the picture: the page gets the click exactly there, the cursor goes there first, and the
// picture comes back only after the page reacted (it repaints 250 ms after the click).
const points = []; const emit = (p) => points.push(p);
const before = pic(res).source.data;
res = await clickAt(conn, { points: [{ x: 300, y: 200 }] }, emit);
assert.equal(res.isError, false, said(res));
assert.deepEqual(await value('() => hits'), [[300, 200, 0]]);
assert.ok(points.length === 1 && points[0].verb === 'click' && Number.isFinite(points[0].screenX), 'the cursor was sent there');
assert.match(said(res), /changed and came to rest/);
assert.notEqual(pic(res).source.data, before, 'the picture shows the page after it reacted');
assert.equal(await value('() => document.querySelectorAll("[data-senju-mark]").length'), 0, 'the click marks are gone from the page');

// Several positions in one call, in order, each with the cursor; and a right-click.
points.length = 0;
res = await clickAt(conn, { points: [{ x: 100, y: 100 }, { x: 500, y: 400 }, { x: 800, y: 50 }] }, emit);
assert.deepEqual((await value('() => hits')).slice(1), [[100, 100, 0], [500, 400, 0], [800, 50, 0]]);
assert.equal(points.length, 3);
await clickAt(conn, { points: [{ x: 50, y: 500 }], button: 'right' }, emit);
assert.deepEqual((await value('() => hits')).at(-1), [50, 500, 2]);

// A drag: pressed at the first position, released at the last.
res = await clickAt(conn, { points: [{ x: 200, y: 300 }, { x: 600, y: 350 }], drag: true }, emit);
assert.deepEqual(await value('() => drags'), [[200, 300, 600, 350]]);
assert.match(said(res), /Dragged/);

// A click on something that does not react: said so, without a long wait.
let t0 = Date.now();
res = await clickAt(conn, { points: [{ x: 950, y: 300 }], wait: 0.6 }, emit);   // right of the canvas: empty page
assert.match(said(res), /Nothing on the page changed/);
assert.ok(Date.now() - t0 < 4000);

// Zooming in: the area comes back enlarged, and a position in the enlarged picture lands on the right page pixel.
res = await look(conn, { region: { x: 400, y: 100, width: 200, height: 100 } });
const zoom = jpegSize(pic(res).source.data);
assert.ok(Math.abs(zoom[0] - 600) <= 2 && Math.abs(zoom[1] - 300) <= 2, `enlarged ×3: ${zoom}`);
assert.match(said(res), /enlarged ×3/);
await value('() => { hits.length = 0; return true; }');
res = await clickAt(conn, { points: [{ x: 300, y: 150 }] }, emit);   // the middle of the enlarged picture
assert.deepEqual(await value('() => hits'), [[500, 150, 0]]);
// A zoom inside the zoom is measured in the enlarged picture's pixels.
res = await look(conn, { region: { x: 0, y: 0, width: 300, height: 150 } });
await value('() => { hits.length = 0; return true; }');
await clickAt(conn, { points: [{ x: 0, y: 0 }] }, emit);
assert.deepEqual(await value('() => hits'), [[400, 100, 0]]);
// A larger area is enlarged only as far as helps: to 1000 px on its long side.
res = await look(conn, {});
res = await look(conn, { region: { x: 100, y: 50, width: 500, height: 400 } });
assert.ok(Math.abs(jpegSize(pic(res).source.data)[0] - 1000) <= 2, `a 500 px area comes back 1000 px wide: ${jpegSize(pic(res).source.data)}`);
await value('() => { hits.length = 0; return true; }');
await clickAt(conn, { points: [{ x: 500, y: 400 }] }, emit);   // its middle
assert.deepEqual(await value('() => hits'), [[350, 250, 0]]);
// A position outside the picture is refused.
res = await clickAt(conn, { points: [{ x: 5000, y: 10 }] }, emit);
assert.equal(res.isError, true);

// On a scrolled page the picture is of what is visible, and positions are still the visible page's.
await value('() => { hits.length = 0; return true; }');
await callTool(conn, 'browser_run_code_unsafe', { code: 'async (page) => { await page.mouse.wheel(0, 300); await page.waitForTimeout(300); return true; }' });
assert.equal(await value('() => scrollY'), 300);
res = await look(conn, {});
res = await clickAt(conn, { points: [{ x: 300, y: 100 }] }, emit);
assert.deepEqual(await value('() => hits'), [[300, 100, 0]]);
assert.equal(await value('() => scrollY'), 300, 'looking and clicking do not scroll the page');

// After the page moved on (a navigation, a scroll), positions from the old picture are refused until it looks again.
conn.viewStale = true;
res = await clickAt(conn, { points: [{ x: 300, y: 100 }] }, emit);
assert.ok(res.isError && /Look again/.test(said(res)));
res = await look(conn, {});
assert.equal((await clickAt(conn, { points: [{ x: 300, y: 100 }] }, emit)).isError, false);

// Browser workers are offered both tools next to the server's own.
const { tools } = buildToolset([conn], (c) => (canSee(c) ? VISION_TOOLS : []));
assert.ok(tools.some((t) => t.name === 'browser__browser_look') && tools.some((t) => t.name === 'browser__browser_click_at'));
// Every tool is in the shape the API requires; one that is not fails every request of the worker that has it.
const shape = (list) => { for (const t of list) { assert.deepEqual(Object.keys(t).sort(), ['description', 'input_schema', 'name'], `tool ${t.name}`); assert.equal(t.input_schema.type, 'object', `tool ${t.name}`); assert.ok(typeof t.description === 'string' && t.description.length > 0 && /^[a-zA-Z0-9_-]{1,64}$/.test(t.name), `tool ${t.name}`); } };
shape(tools);
shape(buildToolset([conn], () => [SCROLL_TOOL, ...VISION_TOOLS]).tools);
// A tool of the app's own written with MCP's inputSchema is put right, not passed on broken.
shape(buildToolset([conn], () => [{ name: 'x_tool', description: 'x', inputSchema: { type: 'object', properties: {} } }]).tools);

// A page that keeps moving by itself (an animation): no waiting for it to come to rest.
await value('() => { hits.length = 0; const d = document.createElement("div"); d.style.cssText = "position:fixed;right:0;top:0;width:60px;height:60px;background:red"; document.body.append(d); setInterval(() => { d.style.background = "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0"); }, 30); return true; }');
res = await look(conn, {});
t0 = Date.now();
res = await clickAt(conn, { points: [{ x: 300, y: 200 }] }, emit);
assert.match(said(res), /keeps moving by itself/);
assert.ok(Date.now() - t0 < 4000, `no long wait on a moving page: ${Date.now() - t0} ms`);
// Looking at the part being worked on leaves the moving part out, and the page is seen to come to rest again.
res = await look(conn, { region: { x: 0, y: 0, width: 900, height: 600 } });
res = await clickAt(conn, { points: [{ x: 500, y: 100 }] }, emit);
assert.match(said(res), /changed and came to rest/);

await conn.close();
srv.close();
console.log('vision test passed');
process.exit(0);
