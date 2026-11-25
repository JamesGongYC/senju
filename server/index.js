// Server entry point: the hub (WebSocket), a small HTTP API, and the web app's files.
//
//   SUPABASE_URL                                   from your Supabase project
//   SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY  its API keys (the older names
//                                                  SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY also work)
//   KEY_ENCRYPTION_SECRET   a long random string; encrypts people's API keys at rest
//   ANTHROPIC_API_KEY       optional. With it, people can run sessions on this server's key and pay in credits.
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET   optional. Needed to sell the plan and credits.
//   PUBLIC_URL              this server's public address, for the pages Stripe sends people back to
//   PORT                    default 8787
//   SWARM_MODEL             default claude-sonnet-5-5
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from './hub.js';
import { handleApi } from './api.js';
import { SupabaseStore } from './store-supabase.js';
import { Billing, verifyWebhook } from './billing.js';
import { makeLlm } from '../src/llm.js';
import { exchange as openRouterExchange } from '../src/openrouter-connect.js';
import { keysFromEnv, parseKeys, guessProvider, checkKey, providers as allProviders, resolveModel } from '../src/models.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
// A local .env.server file is read if present, so secrets stay out of the shell history.
const envFile = path.join(ROOT, '.env.server');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const publicKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
const secretKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const missing = [['SUPABASE_URL', env.SUPABASE_URL], ['SUPABASE_PUBLISHABLE_KEY', publicKey], ['SUPABASE_SECRET_KEY', secretKey], ['KEY_ENCRYPTION_SECRET', env.KEY_ENCRYPTION_SECRET]].filter(([, v]) => !v || /^\.\.\.$|YOUR-PROJECT/.test(v)).map(([k]) => k);
if (missing.length) {
  console.error(`The team server cannot start. Missing: ${missing.join(', ')}.\nCopy server/env.example to .env.server in the project folder and fill it in, or set them in the host's settings.`);
  process.exit(1);
}
if (publicKey === secretKey) { console.error('SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY are the same value. The secret key must never be the one sent to browsers.'); process.exit(1); }
const store = new SupabaseStore({ url: env.SUPABASE_URL, serviceKey: secretKey, encryptionSecret: env.KEY_ENCRYPTION_SECRET });
const billing = new Billing({ store, env, log: (...a) => console.error(...a) });
// Hosted keys, by provider: ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, TOGETHER_API_KEY, GROQ_API_KEY.
const hostedKeys = keysFromEnv(env);
const hostedKey = Object.keys(hostedKeys).length ? hostedKeys : null;
if (hostedKey && !billing.enabled) console.error('Hosted API keys are set but STRIPE_SECRET_KEY is not: nobody can buy credits, so hosted sessions cannot start.');
if (billing.enabled && !billing.webhookSecret) console.error('STRIPE_WEBHOOK_SECRET is not set: payments will be taken but credits will not be added.');
// The models sessions run on unless the desktop app that starts one chooses others.
const model = env.SWARM_MODEL ?? 'claude-sonnet-5-5';
const config = {
  model, plannerModel: model, ...(env.SWARM_WORKER_MODEL ? { workerModel: env.SWARM_WORKER_MODEL } : {}),
  maxAgents: Number(env.SWARM_MAX_AGENTS ?? 4), maxSteps: 300, tokenBudget: Number(env.SWARM_TOKEN_BUDGET ?? 40000000),
  context: { enabled: true, clearToolResultsAt: 200000, keepToolResults: 10, compactAt: 500000 },
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg' };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
const readRaw = (req, limit) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});
const readBody = async (req, limit = 10000) => { try { return JSON.parse((await readRaw(req, limit)) || '{}'); } catch { throw new Error('bad json'); } };
const signedIn = (req) => store.verifyToken((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
// Where Stripe sends people back to. Set PUBLIC_URL in production; locally the request's own address is right.
const originOf = (req) => (env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers.host}`).replace(/\/+$/, '');

for (const m of [config.model, config.workerModel].filter(Boolean)) { try { resolveModel(m, config); } catch (err) { console.error(`SWARM_MODEL / SWARM_WORKER_MODEL: ${err.message}`); process.exit(1); } }
const hub = new Hub({ store, makeLlm: (keys) => makeLlm(keys, config), config, hostedKey, pricing: hostedKey ? billing.p : null, traceDir: env.SWARM_TRACE_DIR ?? null, log: (...a) => console.error(...a) });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-senju-team', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' });
      return res.end();
    }
    if (url.pathname === '/health') return json(res, 200, { ok: true });
    // What a client needs to reach Supabase. The publishable key is public by design.
    if (url.pathname === '/api/config') return json(res, 200, { supabaseUrl: env.SUPABASE_URL, supabaseAnonKey: publicKey });
    // "Connect OpenRouter" from the web page: OpenRouter sent the person back with a code; the page sends it here
    // with its PKCE secret, and the key it is swapped for is saved like a pasted one. The key never reaches the page.
    if (url.pathname === '/api/key/openrouter' && req.method === 'POST') {
      const user = await signedIn(req);
      if (!user) return json(res, 401, { error: 'Sign in again.' });
      const body = await readBody(req);
      const code = String(body.code ?? ''), verifier = String(body.verifier ?? '');
      if (!code || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return json(res, 400, { error: 'That connection request is incomplete. Try Connect OpenRouter again.' });
      let key;
      try { key = await openRouterExchange(code, verifier); } catch (err) { return json(res, 400, { error: err.message }); }
      const saved = parseKeys(await store.getKey(user.id));
      saved.openrouter = key;
      await store.setKey(user.id, JSON.stringify(saved));
      return json(res, 200, { ok: true, providers: Object.keys(saved) });
    }
    // Your own API keys, one per provider. They are never sent back: GET lists which providers have one.
    if (url.pathname === '/api/key') {
      const user = await signedIn(req);
      if (!user) return json(res, 401, { error: 'Sign in again.' });
      const saved = parseKeys(await store.getKey(user.id));
      const list = () => ({ providers: Object.keys(saved), known: Object.entries(allProviders(config)).filter(([, p]) => p.keyEnv).map(([id, p]) => ({ id, label: p.label, hint: p.keyHint, limits: p.limits ?? null, connect: Boolean(p.connect) })) });
      if (req.method === 'GET') return json(res, 200, list());
      if (req.method === 'DELETE') {
        const which = url.searchParams.get('provider');
        if (which) delete saved[which]; else for (const k of Object.keys(saved)) delete saved[k];
        if (Object.keys(saved).length) await store.setKey(user.id, JSON.stringify(saved)); else await store.deleteKey(user.id);
        return json(res, 200, { ok: true, ...list() });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const key = String(body.key ?? '').trim();
        const provider = String(body.provider ?? '') || guessProvider(key);
        if (!provider) return json(res, 400, { error: 'Choose which provider this key is for.' });
        const problem = checkKey(provider, key, config);
        if (problem) return json(res, 400, { error: problem });
        saved[provider] = key;
        await store.setKey(user.id, JSON.stringify(saved));
        return json(res, 200, { ok: true, ...list() });
      }
      return json(res, 405, { error: 'Use GET, POST or DELETE.' });
    }
    // ---- Sessions, skills, memory, team (the control page) ----
    if (url.pathname.startsWith('/api/') && await handleApi({ req, url, user: await signedIn(req), store, hub, json: (code, body) => (json(res, code, body), true), readBody })) return;
    // ---- Plan and credits ----
    if (url.pathname === '/api/billing') {
      const user = await signedIn(req);
      if (!user) return json(res, 401, { error: 'Sign in again.' });
      return json(res, 200, await billing.summary(user.id, { hasOwnKey: Boolean(await store.getKey(user.id)), hosted: Boolean(hostedKey) }));
    }
    if (url.pathname === '/api/billing/checkout' || url.pathname === '/api/billing/portal') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
      const user = await signedIn(req);
      if (!user) return json(res, 401, { error: 'Sign in again.' });
      try {
        const to = url.pathname.endsWith('portal') ? await billing.portal(user, originOf(req)) : await billing.checkout(user, await readBody(req), originOf(req));
        return json(res, 200, { url: to });
      } catch (err) { return json(res, 400, { error: String(err?.message ?? err) }); }
    }
    // Stripe tells us here that money arrived. Nothing is credited unless the signature is Stripe's.
    if (url.pathname === '/api/stripe/webhook') {
      if (req.method !== 'POST' || !billing.webhookSecret) return json(res, 400, { error: 'Not accepting webhooks.' });
      let event;
      try { event = verifyWebhook(await readRaw(req, 1_000_000), req.headers['stripe-signature'], billing.webhookSecret); }
      catch (err) { return json(res, 400, { error: String(err?.message ?? err) }); }
      return json(res, 200, { received: true, result: await billing.handleEvent(event) });   // an error here becomes a 500, and Stripe retries
    }
    // The Supabase browser library, served from our own install so the page needs no CDN.
    if (url.pathname === '/vendor/supabase.js') {
      res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'public, max-age=86400' });
      return fs.createReadStream(path.join(ROOT, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js')).pipe(res);
    }
    // Everything else is the web app.
    const rel = path.normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(ROOT, 'web', rel);
    if (!file.startsWith(path.join(ROOT, 'web')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    json(res, 500, { error: String(err?.message ?? err) });
  }
});

hub.listen(server);
const port = Number(env.PORT ?? 8787);
server.listen(port, () => console.log(`Senju server on http://localhost:${port}`));
