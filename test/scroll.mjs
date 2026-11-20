import http from 'node:http';
// Pointing and scroll test, in a real headless browser: browser_scroll, the scroll before clicking an element out of
// view, and the cursor's aim on an element inside a cross-origin iframe.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectServer, callTool, buildToolset } from '../src/mcp.js';
import { scrollWithCursor, pointBefore, readPage, foundRef, SCROLL_TOOL, evalResult } from '../src/point.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = `<!doctype html><body style="margin:0;font:16px sans-serif">
<div style="height:3000px;background:linear-gradient(#fff,#ccd)"><h1>Top</h1></div>
<div id="side" style="position:fixed;right:0;top:0;width:200px;height:300px;overflow:auto;background:#eee"><div style="height:2000px">side<div style="margin-top:1800px"><button>Deep in side</button></div></div></div>
<button id="far" onclick="this.textContent='clicked'">Far button</button><div style="height:500px"></div></body>`;
const inner = `<body style="margin:0"><div style="height:1200px"></div><button style="margin-left:30px" onclick="this.textContent='hit'">Inner button</button></body>`;
const framed = (port) => `<body style="margin:0"><div style="height:200px">top</div><iframe src="http://localhost:${port}/inner" style="display:block;margin-left:300px;width:400px;height:300px;border:0"></iframe></body>`;
// A chat app: the page does not scroll, its message list does, and it sits at the newest message.
const chat = `<body style="margin:0;overflow:hidden;height:100vh"><div id="log" style="height:100vh;overflow-y:auto">${'<p style="height:60px">message</p>'.repeat(80)}</div><script>log.scrollTop = log.scrollHeight</script></body>`;
const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(q.url === '/inner' ? inner : q.url === '/framed' ? framed(srv.address().port) : q.url === '/chat' ? chat : page); }).listen(0);
const url = `http://127.0.0.1:${srv.address().port}/`;
const conn = await connectServer('browser', { command: process.execPath, args: [path.join(root, 'node_modules/@playwright/mcp/cli.js'), '--headless', '--isolated'] });
const { tools } = buildToolset([conn], () => [SCROLL_TOOL]);
assert.ok(tools.some((t) => t.name === 'browser__browser_scroll'), 'browser_scroll is offered');
await callTool(conn, 'browser_navigate', { url });
const points = []; const emit = (p) => points.push(p);
const scrollY = async () => Number((await callTool(conn, 'browser_evaluate', { function: '() => document.scrollingElement.scrollTop' })).content[0].text.match(/### Result\s*\n(\d+)/)[1]);

// Reading a long page: it scrolls down under the cursor a screen at a time and stays where reading ended.
const reading = readPage(conn, emit);
assert.ok(conn.reading, 'actions on this window wait for the reading');
await reading;
assert.equal(conn.reading, null);
const readScrolls = points.filter((p) => p.verb === 'scroll');
assert.ok(readScrolls.length >= 2 && readScrolls.every((p) => p.dir === 'down'), `read on, a screen at a time: ${readScrolls.length}`);
assert.ok(!points.some((p) => p.verb === 'read'), 'no skimming over the text');
const afterRead = await scrollY();
assert.ok(afterRead > 600, `the page stays where reading ended (${afterRead})`);
const n = points.length;
await readPage(conn, emit);
assert.equal(points.length, n, 'a page already read is not read through again');
// Reading one thing that is out of view (a browser_find match): the cursor scrolls to it.
await callTool(conn, 'browser_evaluate', { function: '() => window.scrollTo(0, 0)' });
const found = await callTool(conn, 'browser_find', { text: 'Far button' }).catch(() => null);
const fref = found && !found.isError ? foundRef(found.content.map((c) => c.text).join('\n')) : null;
if (fref) {
  await readPage(conn, emit, { target: fref, element: 'Far button' });
  assert.equal(points.at(-1).verb, 'scroll');
  assert.ok((await scrollY()) > 1500, 'scrolled to what it found');
} else console.log('(browser_find not available here; skipped the found-text case)');
await callTool(conn, 'browser_evaluate', { function: '() => window.scrollTo(0, 0)' });
points.length = 0;
const check = (r, moved, re) => { assert.equal(r.moved, moved, r.content[0].text); assert.match(r.content[0].text, re); };
check(await scrollWithCursor(conn, { direction: 'down' }, emit), true, /^Scrolled down\. The page is now \d+% of the way/);
check(await scrollWithCursor(conn, { direction: 'up', pages: 5 }, emit), true, /at the start/);
check(await scrollWithCursor(conn, { direction: 'up' }, emit), false, /already at the top/);
const snap = (await callTool(conn, 'browser_snapshot', {})).content[0].text;
const ref = (re) => snap.match(re)?.[1];
const deep = ref(/button "Deep in side" \[ref=(e\d+)\]/), far = ref(/button "Far button" \[ref=(e\d+)\]/);
check(await scrollWithCursor(conn, { direction: 'down', target: deep, element: 'side panel' }, emit), true, /That area is now/);
check(await scrollWithCursor(conn, { target: deep, element: 'Deep in side' }, emit), true, /until Deep in side is in view/);
await callTool(conn, 'browser_evaluate', { function: '() => window.scrollTo(0, 0)' });
const before = points.length;
await pointBefore(conn, 'browser_click', { target: far, element: 'Far button' }, emit);
assert.deepEqual(points.slice(before).map((p) => p.verb), ['scroll', 'click'], 'the cursor scrolls to an element out of view, then clicks');
assert.equal(points.at(-1).inView, true);
assert.ok(!(await callTool(conn, 'browser_click', { target: far, element: 'Far button' })).isError);
assert.ok(points.filter((p) => p.verb === 'scroll').every((p) => Number.isFinite(p.screenX) && p.dir), 'scroll points carry a spot and a direction');

// A chat at its newest message: it scrolls up its message list to read, then back down to the bottom.
await callTool(conn, 'browser_navigate', { url: `http://127.0.0.1:${srv.address().port}/chat` });
const logPos = async () => evalResult((await callTool(conn, 'browser_evaluate', { function: '() => [log.scrollTop, log.scrollHeight - log.clientHeight]' })).content[0].text);
const [startTop, maxTop] = await logPos();
assert.ok(startTop >= maxTop - 2, 'starts at the bottom');
let mark0 = points.length;
await readPage(conn, emit);
const dirs = points.slice(mark0).filter((p) => p.verb === 'scroll').map((p) => p.dir);
assert.ok(dirs.includes('up') && dirs.at(-1) === 'down', `up to read, then down: ${dirs}`);
assert.ok((await logPos())[0] >= maxTop - 2, 'back at the newest message');
// Stopped while reading (the worker acts): it is back at the bottom before the action.
await callTool(conn, 'browser_evaluate', { function: '() => { log.insertAdjacentHTML("beforeend", "<p style=height:60px>new</p>".repeat(30)); log.scrollTop = log.scrollHeight; }' });
const again = readPage(conn, emit);
await new Promise((r) => setTimeout(r, 500));
conn.stopReading();
await again;
const [t2, m2] = await logPos();
assert.ok(t2 >= m2 - 2, `stopped reading leaves the chat at its bottom (${t2} of ${m2})`);

// Inside a cross-origin iframe: the cursor goes where the button is on the page, not where it is in its frame.
await callTool(conn, 'browser_navigate', { url: `http://127.0.0.1:${srv.address().port}/framed` });
const fsnap = (await callTool(conn, 'browser_snapshot', {})).content[0].text;
const inner1 = fsnap.match(/button "Inner button" \[ref=(\w+)\]/)[1];
assert.match(inner1, /^f\d+e\d+$/, 'a frame ref');
const mark = points.length;
await pointBefore(conn, 'browser_click', { target: inner1, element: 'Inner button' }, emit);
const [scrollPt, clickPt] = points.slice(mark);
assert.equal(scrollPt.verb, 'scroll', 'the frame is scrolled with the cursor first');
assert.ok(scrollPt.x > 300 && scrollPt.x < 700 && scrollPt.y - scrollPt.chromeTop > 200 && scrollPt.y - scrollPt.chromeTop < 500, `scroll cursor over the frame: ${JSON.stringify(scrollPt)}`);
assert.equal(clickPt.verb, 'click');
const box = evalResult((await callTool(conn, 'browser_run_code_unsafe', { code: `async (page) => await page.locator('aria-ref=${inner1}').boundingBox()` })).content[0].text);
assert.ok(Math.abs(clickPt.x - (box.x + box.width / 2)) <= 1 && Math.abs(clickPt.y - clickPt.chromeTop - (box.y + box.height / 2)) <= 1, `cursor on the button: ${JSON.stringify({ clickPt, box })}`);
assert.ok(box.x > 300 && box.y > 200, 'measured on the page, not inside the frame');
assert.ok(!(await callTool(conn, 'browser_click', { target: inner1, element: 'Inner button' })).isError);
console.log('scroll test passed');
await conn.close(); srv.close(); process.exit(0);
