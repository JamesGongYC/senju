// "Connect OpenRouter": the person signs in to OpenRouter and approves Senju, and OpenRouter hands back a key that
// is theirs (billed to their account, with the spending limit they set, revocable there). No key is copied or pasted.
// OpenRouter's OAuth with PKCE (https://openrouter.ai/docs/use-cases/oauth-pkce):
//   1. send the person to https://openrouter.ai/auth with a callback URL and the SHA-256 (base64url) of a secret;
//   2. OpenRouter sends them back to the callback with ?code=…;
//   3. POST the code and the secret to /api/v1/auth/keys, which answers { key }. A code expires after 10 minutes.
import crypto from 'node:crypto';
import http from 'node:http';

export const AUTH_URL = 'https://openrouter.ai/auth';
export const EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
// Suggested on OpenRouter's page (the person can change or clear it): a key that cannot run up an open-ended bill.
export const SUGGESTED_LIMIT_USD = 20;

export function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, state: crypto.randomBytes(16).toString('base64url') };
}

export function authUrl({ callback, challenge, state, label = 'Senju', limit = SUGGESTED_LIMIT_USD }) {
  const q = new URLSearchParams({ callback_url: callback, code_challenge: challenge, code_challenge_method: 'S256', key_label: label, state });
  if (limit) q.set('limit', String(limit));
  return `${AUTH_URL}?${q}`;
}

// Turn the code into the person's key.
export async function exchange(code, verifier, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(EXCHANGE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }) });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !body?.key) {
    const why = res.status === 403 ? 'the approval expired or did not match. Try connecting again.' : body?.error?.message ?? `OpenRouter answered ${res.status}.`;
    throw new Error(`Could not connect OpenRouter: ${why}`);
  }
  return body.key;
}

const PAGE = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;background:#F42902;color:#FDFDFF"><div style="background:#FDFDFF;color:#141414;padding:28px 32px;border-radius:22px;border:3px solid #141414;max-width:420px"><h2 style="margin:0 0 8px">${title}</h2><p style="margin:0">${text}</p></div>`;

// On this Mac: a one-time page on localhost (any free port) receives the callback. open(url) shows OpenRouter's page
// in the browser. Resolves with the key; rejects if the person declines, or after ten minutes.
export function connectDesktop({ open, fetchImpl, timeoutMs = 10 * 60 * 1000, host = 'localhost' } = {}) {
  const { verifier, challenge, state } = pkce();
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, key) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (err) reject(err); else resolve(key);
    };
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const reply = (code, title, text) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE(title, text)); };
      const code = url.searchParams.get('code');
      if (!code) { reply(400, 'Not connected', 'OpenRouter did not approve Senju. You can close this tab.'); return done(new Error('OpenRouter was not connected: the approval was declined.')); }
      if (url.searchParams.get('state') !== state) { reply(400, 'Not connected', 'This answer was not for this request. Try again from Senju.'); return done(new Error('OpenRouter answered a different request. Try connecting again.')); }
      try {
        const key = await exchange(code, verifier, fetchImpl);
        reply(200, 'OpenRouter is connected', 'Senju saved your key in this Mac’s keychain. You can close this tab and go back to Senju.');
        done(null, key);
      } catch (err) { reply(400, 'Not connected', err.message); done(err); }
    });
    const timer = setTimeout(() => done(new Error('OpenRouter was not connected within ten minutes. Try again.')), timeoutMs);
    server.listen(0, '127.0.0.1', () => {
      const callback = `http://${host}:${server.address().port}/callback`;
      Promise.resolve(open(authUrl({ callback, challenge, state }))).catch((err) => done(err));
    });
    server.on('error', (err) => done(err));
  });
}
