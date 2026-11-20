import http from 'node:http';
// Scroll test: browser_scroll and the scroll before clicking an element out of view, in a real headless browser.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectServer, callTool, buildToolset } from '../src/mcp.js';
import { scrollWithCursor, pointBefore, SCROLL_TOOL } from '../src/point.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = `<!doctype html><body style="margin:0;font:16px sans-serif">
<div style="height:3000px;background:linear-gradient(#fff,#ccd)"><h1>Top</h1></div>
<div id="side" style="position:fixed;right:0;top:0;width:200px;height:300px;overflow:auto;background:#eee"><div style="height:2000px">side<div style="margin-top:1800px"><button>Deep in side</button></div></div></div>
<button id="far" onclick="this.textContent='clicked'">Far button</button><div style="height:500px"></div></body>`;
const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(page); }).listen(0);
const url = `http://127.0.0.1:${srv.address().port}/`;
const conn = await connectServer('browser', { command: process.execPath, args: [path.join(root, 'node_modules/@playwright/mcp/cli.js'), '--headless', '--isolated'] });
const { tools } = buildToolset([conn], () => [SCROLL_TOOL]);
assert.ok(tools.some((t) => t.name === 'browser__browser_scroll'), 'browser_scroll is offered');
await callTool(conn, 'browser_navigate', { url });
const points = []; const emit = (p) => points.push(p);
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
console.log('scroll test passed');
await conn.close(); srv.close(); process.exit(0);
