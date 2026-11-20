// Ads in the way, in a real headless browser: the watcher closes an ad over the page, a full-page ad inside a
// cross-origin iframe and a sticky ad bar, each with a cursor move and a click, and leaves an ordinary dialog alone.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectServer, callTool } from '../src/mcp.js';
import { watchAds, findAd } from '../src/adskip.js';
import { evalResult } from '../src/point.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const article = '<h1>Article</h1>' + '<p>Text.</p>'.repeat(40);
const pages = {
  // A pop-up ad that shows a moment after the page opened.
  '/overlay': `<body>${article}<script>setTimeout(() => document.body.insertAdjacentHTML('beforeend',
    '<div id="pop" style="position:fixed;inset:0;background:#0008"><div class="ad-container" style="margin:80px auto;width:400px;background:#fff">'
    + '<ins class="adsbygoogle" style="display:block;height:250px"></ins><button aria-label="Close ad" onclick="pop.remove()">×</button></div></div>'), 600)</script></body>`,
  // A full-page ad in an iframe from another origin; its close button is inside the frame.
  '/vignette': (port) => `<body>${article}<iframe id="aswift_1" src="http://localhost:${port}/adframe" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>
    <script>addEventListener('message', (e) => { if (e.data === 'closed') { window.__closed = true; aswift_1.remove(); } })</script></body>`,
  '/adframe': `<body style="margin:0;background:#eee"><div style="height:300px">Ad</div><div id="dismiss-button" role="button" style="width:80px;padding:8px;background:#ddd"
    onclick="parent.postMessage('closed', '*')">Close</div></body>`,
  // An ad bar stuck to the bottom of the page.
  '/anchor': `<body>${article}<div class="sticky-ad" style="position:fixed;left:0;right:0;bottom:0;height:90px;background:#ffd"><span>Advertisement</span>
    <span class="ad-close" style="position:absolute;right:6px;top:4px;width:20px;cursor:pointer" onclick="this.parentElement.remove()">✕</span></div></body>`,
  // Not an ad: the page's own dialog, which the worker may be using.
  '/dialog': `<body>${article}<div role="dialog" id="dlg" style="position:fixed;top:100px;left:100px;width:300px;background:#fff"><p>Sign up</p><button onclick="dlg.remove()">Close</button></div></body>`,
};
const srv = http.createServer((q, r) => {
  const page = pages[q.url.replace(/\?.*/, '')] ?? article;
  r.setHeader('content-type', 'text/html; charset=utf-8');
  r.end(typeof page === 'function' ? page(srv.address().port) : page);
}).listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;
const conn = await connectServer('browser', { command: process.execPath, args: [path.join(root, 'node_modules/@playwright/mcp/cli.js'), '--headless', '--isolated'] });
const value = async (fn) => evalResult((await callTool(conn, 'browser_evaluate', { function: fn })).content.map((c) => c.text).join('\n'));
// Wait on the watcher's own word, without calling the browser meanwhile (the watcher waits while the browser is busy).
const closedBy = async (n, ms = 9000) => { const end = Date.now() + ms; while (Date.now() < end && closed.length < n) await sleep(100); await sleep(300); };

const points = [], closed = [];
watchAds(conn, (p) => points.push(p), (label) => closed.push(label));

// The pop-up ad that shows after the page opened: closed with the cursor.
await callTool(conn, 'browser_navigate', { url: `${base}/overlay` });
await closedBy(1);
assert.ok(await value('() => !document.getElementById("pop")'), 'the pop-up ad was closed');
assert.ok(closed.length === 1 && points.some((p) => p.verb === 'click'), `closed with a cursor click: ${JSON.stringify(closed)}`);

// The full-page ad in a cross-origin iframe: its close button inside the frame is clicked.
await callTool(conn, 'browser_navigate', { url: `${base}/vignette` });
await closedBy(2);
assert.ok(await value('() => window.__closed === true'), 'the close button inside the ad frame was clicked');
assert.equal(closed.length, 2);

// The sticky ad bar.
await callTool(conn, 'browser_navigate', { url: `${base}/anchor` });
await closedBy(3);
assert.ok(await value('() => !document.querySelector(".sticky-ad")'), 'the ad bar was closed');
assert.equal(closed.length, 3);

// The page's own dialog stays.
await callTool(conn, 'browser_navigate', { url: `${base}/dialog` });
await sleep(2500);
assert.ok(await value('() => !!document.getElementById("dlg")'), 'an ordinary dialog is not closed');
assert.equal(await findAd(conn), null);
assert.equal(closed.length, 3);

conn.adWatch.stop();
await conn.close();
srv.close();
console.log('ads test passed');
process.exit(0);
