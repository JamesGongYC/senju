// Ads that get in the way, on any site: a video ad's "Skip" button (it only shows up some seconds into the ad), an
// ad that covers the page (an interstitial or "vignette", a pop-up ad, an ad bar stuck to the bottom), and the
// same inside an ad's own iframe. While a worker's browser is open, check it about once a second, and when one
// is showing, move the cursor to its close or skip button and click it through browser_click, as a person
// would. Only boxes that are clearly ads count, so dialogs the worker opened itself are left alone.
// Best effort: never throws.
import { callTool } from './mcp.js';
import { pointBefore, evalResult } from './point.js';

// Runs in the page. Returns { selector, label } for the button to click, { frames: true } when an ad in an
// iframe covers the page (its close button is looked for with Playwright, which reaches into other origins),
// or null.
export const FIND = `() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.title || '').replace(/\\s+/g, ' ').trim();
  const mark = (el, text) => {
    document.querySelectorAll('[data-senju-ad]').forEach((e) => e.removeAttribute('data-senju-ad'));
    el.setAttribute('data-senju-ad', '1');
    return { selector: '[data-senju-ad="1"]', label: label(el).slice(0, 40) || text };
  };

  // YouTube's video ads: the Skip button, or the close button of an ad banner over the video.
  if (/(^|\\.)youtube\\.com$/.test(location.hostname)) {
    const SKIP = ['.ytp-skip-ad-button', '.ytp-ad-skip-button-modern', '.ytp-ad-skip-button', '.ytp-ad-skip-button-slot button', 'button[id^="skip-button"]', '.ytp-ad-overlay-close-button'];
    let hit = null;
    for (const sel of SKIP) { hit = [...document.querySelectorAll(sel)].find(visible); if (hit) break; }
    // A renamed button: anything in the ad area whose text is Skip / Skip ad / Skip ads.
    if (!hit) hit = [...document.querySelectorAll('.video-ads button, .ytp-ad-module button, .ytp-ad-player-overlay button')]
      .find((b) => visible(b) && /^skip( ads?)?$/i.test(label(b)));
    if (hit) return mark(hit, hit.matches('.ytp-ad-overlay-close-button') ? 'Close ad' : 'Skip');
  }

  // Any site: an ad in an overlay (fixed, sticky or a dialog) with a close button.
  const AD_WORD = /(^|[\\s_-])(ad|ads|advert|adverts|advertisement|adsbygoogle|adslot|ad-slot|adunit|ad-unit|adcontainer|ad-container|adwrapper|ad-wrapper|sponsor|sponsored|interstitial|vignette|dfp|gpt-ad|taboola|outbrain)([\\s_\\d-]|$)/i;
  const AD_HOST = /doubleclick\\.net|googlesyndication\\.com|googleadservices\\.com|adservice\\.google|amazon-adsystem\\.com|adnxs\\.com|taboola\\.com|outbrain\\.com|criteo\\.(com|net)|pubmatic\\.com|rubiconproject\\.com|media\\.net|smartadserver\\.com|adform\\.net|teads\\.tv/i;
  const AD_EL = 'ins.adsbygoogle, [data-ad-slot], [data-ad-unit], [data-google-query-id], [id^="google_ads"], [id^="div-gpt-ad"], [aria-label="Advertisement" i]';
  const CLOSE = /^(close|close ad|close this ad|close advertisement|dismiss|dismiss ad|skip|skip ad|skip ads|no thanks|no, thanks|continue to site|continue to the site|×|✕|✖|x)$/i;
  const names = (n) => (n.id || '') + ' ' + (typeof n.className === 'string' ? n.className : n.className?.baseVal ?? '');
  const adFrame = (f) => AD_HOST.test(f.src || '') || /^(aswift_|google_ads_iframe)/.test(f.id || f.name || '');
  const isAd = (n) => AD_WORD.test(names(n)) || n.matches(AD_EL) || /^(advertisement|sponsored|ad)\\b/i.test((n.innerText || '').trim().slice(0, 20))
    || Boolean(n.querySelector(AD_EL)) || [...n.querySelectorAll('iframe')].some(adFrame);
  const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  const overlay = (el) => {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = up(n)) {
      const s = getComputedStyle(n);
      if (s.position === 'fixed' || s.position === 'sticky' || n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true') return n;
    }
    return null;
  };
  // Is there an ad between this element and its overlay, or in the overlay itself?
  const inAd = (el, box) => { for (let n = el; n; n = up(n)) { if (n !== el && isAd(n)) return true; if (n === box) return false; } return false; };
  const deep = (sel) => { const out = []; const walk = (root) => { for (const e of root.querySelectorAll('*')) { if (e.matches(sel)) out.push(e); if (e.shadowRoot) walk(e.shadowRoot); } }; walk(document); return out; };
  const closeClass = (el) => /(^|[-_\\s])(close|dismiss)([-_\\s]|button|btn|$)/i.test(names(el));
  // Real buttons first; a div or span only when it is button-sized and holds no part of the ad itself.
  const order = (el) => (el.matches('button, [role=button], [aria-label]') ? 0 : 1);
  for (const el of deep('button, [role=button], a, div, span, svg, [aria-label]').filter(visible).sort((a, b) => order(a) - order(b))) {
    const r = el.getBoundingClientRect();
    if (r.width > 200 || r.height > 80 || el.querySelector('ins, iframe, img, video')) continue;
    const text = label(el);
    const small = r.width < 64;
    if (!(CLOSE.test(text) || /^(close|dismiss)\\b/i.test(el.getAttribute('aria-label') || '') || (small && text.length <= 1 && closeClass(el)))) continue;
    const box = overlay(el);
    if (box && inAd(el, box)) return mark(el, 'Close ad');
  }

  // An ad in an iframe of its own that covers much of the page, or sits in an overlay: mark it, and its close
  // button is looked for inside the frame.
  document.querySelectorAll('[data-senju-adtop]').forEach((e) => e.removeAttribute('data-senju-adtop'));
  let frames = false;
  for (const f of deep('iframe').filter(visible)) {
    const r = f.getBoundingClientRect();
    const big = (Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * (Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) > 0.4 * innerWidth * innerHeight;
    const box = overlay(f);
    if (!(adFrame(f) || (box && inAd(f, box)))) continue;
    if (!(big || box)) continue;
    f.setAttribute('data-senju-adtop', '1');
    frames = true;
  }
  return frames ? { frames: true } : null;
}`;

// Runs with Playwright (browser_run_code_unsafe): in the frames marked above and the frames inside them, find a
// visible close or skip button, mark it and the frames on the way down, and return a selector that reaches it.
const IN_FRAMES = `async (page) => {
  const BUTTONS = ['#dismiss-button', '#close-button', '[aria-label="Close ad" i]', '[aria-label^="Close" i]', '[aria-label^="Dismiss" i]', '[class*="close-button" i]', '[class*="closeButton"]', '[role=button]:text-is("Close")', 'button:text-is("Close")', ':text-is("Close ad")', ':text-is("Skip ad")', ':text-is("Skip")'];
  const vp = page.viewportSize() || { width: 1e5, height: 1e5 };
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    // Only frames inside an ad iframe the page check marked.
    let marked = false;
    for (let cur = f; cur.parentFrame(); cur = cur.parentFrame()) {
      const el = await cur.frameElement().catch(() => null);
      if (el && (await el.getAttribute('data-senju-adtop').catch(() => null)) === '1') { marked = true; break; }
    }
    if (!marked) continue;
    for (const sel of BUTTONS) {
      const b = f.locator(sel).first();
      if (!(await b.count().catch(() => 0)) || !(await b.isVisible().catch(() => false))) continue;
      const box = await b.boundingBox().catch(() => null);
      if (!box || box.width < 4 || box.x + box.width < 0 || box.y + box.height < 0 || box.x > vp.width || box.y > vp.height) continue;
      const tag = Math.random().toString(36).slice(2, 10);
      const parts = [];
      for (let cur = f; cur.parentFrame(); cur = cur.parentFrame()) {
        const el = await cur.frameElement();
        await el.evaluate((e, t) => e.setAttribute('data-senju-adf', t), tag);
        parts.unshift('[data-senju-adf="' + tag + '"] >> internal:control=enter-frame');
      }
      await b.evaluate((e, t) => e.setAttribute('data-senju-ad', t), tag);
      const label = ((await b.getAttribute('aria-label').catch(() => '')) || (await b.innerText().catch(() => '')) || 'Close ad').replace(/\\s+/g, ' ').trim().slice(0, 40);
      return { selector: parts.join(' >> ') + ' >> [data-senju-ad="' + tag + '"]', label: label || 'Close ad' };
    }
  }
  return null;
}`;

export const AD_CHECK_MS = 1000;
const text = (res) => res?.content?.map((c) => c.text).join('\n');

/** The ad button to click on this browser's page now, or null. */
export async function findAd(conn) {
  const found = evalResult(text(await callTool(conn, 'browser_evaluate', { function: FIND })));
  if (found?.selector) return found;
  if (found?.frames && conn.tools?.some((t) => t.name === 'browser_run_code_unsafe')) {
    const res = await callTool(conn, 'browser_run_code_unsafe', { code: IN_FRAMES });
    const inside = res && !res.isError ? evalResult(text(res)) : null;
    if (inside?.selector) return inside;
  }
  return null;
}

/**
 * Start watching one browser connection for ads in the way (once per connection). Stops when the connection closes.
 * @param {object} conn    the worker's browser connection
 * @param {(point: object) => void} emit   moves this worker's cursor
 * @param {(label: string) => void} [onSkip]  told after each click
 */
export function watchAds(conn, emit, onSkip) {
  if (conn.adWatch) return;
  let stopped = false, checking = false, misses = 0, restUntil = 0;
  const tick = async () => {
    // Never in the middle of the worker's own action or while it reads with the cursor, and one check at a time.
    if (stopped || checking || conn.inflight > 0 || conn.reading || Date.now() < restUntil) return;
    checking = true;
    try {
      const found = await findAd(conn);
      if (!stopped && found?.selector && !(conn.inflight > 0)) {
        const args = { element: `ad button "${found.label}"`, target: found.selector };
        await pointBefore(conn, 'browser_click', args, emit);
        const res = await callTool(conn, 'browser_click', args);
        if (!res?.isError) { misses = 0; onSkip?.(found.label); }
        else if (++misses >= 3) { misses = 0; restUntil = Date.now() + 30_000; }   // it keeps failing: leave it a while
      }
    } catch { /* try again next tick */ }
    checking = false;
  };
  const timer = setInterval(tick, AD_CHECK_MS);
  timer.unref?.();
  const close = conn.close;
  conn.adWatch = { stop: () => { stopped = true; clearInterval(timer); } };
  conn.close = (...a) => { conn.adWatch.stop(); return close(...a); };
}
