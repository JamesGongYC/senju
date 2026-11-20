// Reading an app window: where text is cut off, which way it scrolls, and that a chat goes back to its bottom.
import assert from 'node:assert/strict';
import { textOutOfView, readWindow } from '../src/deskpoint.js';

const bounds = { x: 600, y: 100, width: 600, height: 800 };
const text = (y, h = 18) => ({ role: 'AXStaticText', frame: { x: 700, y, w: 300, h } });
const window = (slivers) => ({
  pid: 42, window_id: 7, screenshot_scale: 2, window_bounds: bounds,
  elements: [
    { role: 'AXWebArea', frame: { x: 600, y: 100, w: 600, h: 800 } },
    text(100, 1), text(100, 1),                                        // sticky header: always there
    ...Array.from({ length: slivers.top }, () => text(100, 1)),
    text(300), text(500),
    ...Array.from({ length: slivers.bottom }, () => text(899, 1)),
  ],
});

// At the top of a long document: text below only.
let at = textOutOfView(window({ top: 0, bottom: 30 }));
assert.ok(at.below > 4 && at.above <= 4, JSON.stringify(at));
assert.deepEqual(at.spot, { x: 900, y: 540 });
// A chat at its newest message: text above only.
at = textOutOfView(window({ top: 40, bottom: 0 }));
assert.ok(at.above > 4 && at.below === 0);

// A fake driver that scrolls and says how far.
const conn = (moves) => ({
  calls: [],
  client: { callTool: async ({ name, arguments: args }) => { conn.last.calls.push({ name, ...args }); const pt = moves.shift() ?? 0; return pt ? { content: [{ type: 'text', text: `Sent, effect not verified: Scrolled ${args.direction} about ${pt} pt in the background through accessibility` }] } : { content: [{ type: 'text', text: 'Background scroll is unavailable' }], isError: true }; } },
});
const make = (moves) => (conn.last = conn(moves));

// Reading on down a document: two steps down, and it stays there.
let c = make([400, 400]);
let points = [];
await readWindow(c, window({ top: 0, bottom: 30 }), (p) => points.push(p)).done;
assert.deepEqual(c.calls.map((k) => k.direction), ['down', 'down']);
assert.deepEqual([c.calls[0].x, c.calls[0].y], [600, 880], 'window-local, in screenshot pixels');
assert.ok(points.every((p) => p.verb === 'scroll' && p.screenX === 900 && p.screenY === 540));

// A chat: up to read, then back down by the same distance.
c = make([300, 200, 400, 100]);
await readWindow(c, window({ top: 40, bottom: 0 }), () => {}).done;
assert.deepEqual(c.calls.map((k) => k.direction), ['up', 'up', 'down', 'down']);

// Stopped on the way up (the worker acts): it still goes back down, at once.
c = make([300, 300, 300, 300]);
const r = readWindow(c, window({ top: 40, bottom: 0 }), () => {});
await new Promise((res) => setTimeout(res, 300));
r.stop();
const t0 = Date.now();
await r.done;
assert.equal(c.calls.filter((k) => k.direction === 'up').length, 1);
assert.equal(c.calls.filter((k) => k.direction === 'down').length, 1, 'back by what it scrolled up');
assert.ok(Date.now() - t0 < 1500, 'no pauses to read once stopped');

// Nothing cut off: no scrolling at all. The person typing: no scrolling either.
c = make([300]);
await readWindow(c, window({ top: 0, bottom: 0 }), () => {}).done;
assert.equal(c.calls.length, 0);
c = make([300]);
await readWindow(c, window({ top: 0, bottom: 30 }), () => {}, { busy: () => true }).done;
assert.equal(c.calls.length, 0);

console.log('desk read test passed');
