// Server entry point: the hub (WebSocket), a small HTTP API, and the web app's files.
//
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY   from your Supabase project
//   KEY_ENCRYPTION_SECRET   a long random string; encrypts people's API keys at rest
//   PORT                    default 8787
//   SWARM_MODEL             default claude-sonnet-5-5
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from './hub.js';
import { SupabaseStore } from './store-supabase.js';
import { makeLlm } from '../src/llm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
// A local .env.server file is read if present, so secrets stay out of the shell history.
const envFile = path.join(ROOT, '.env.server');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const store = new SupabaseStore({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, encryptionSecret: env.KEY_ENCRYPTION_SECRET });
const model = env.SWARM_MODEL ?? 'claude-sonnet-5-5';
const config = {
  model, plannerModel: model,
  maxAgents: Number(env.SWARM_MAX_AGENTS ?? 4), maxSteps: 300, tokenBudget: Number(env.SWARM_TOKEN_BUDGET ?? 40000000),
  context: { enabled: true, clearToolResultsAt: 200000, keepToolResults: 10, compactAt: 500000 },
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 10000) { reject(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('bad json')); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS' });
      return res.end();
    }
    if (url.pathname === '/health') return json(res, 200, { ok: true });
    // What a client needs to reach Supabase. The anon key is public by design.
    if (url.pathname === '/api/config') return json(res, 200, { supabaseUrl: env.SUPABASE_URL, supabaseAnonKey: env.SUPABASE_ANON_KEY });
    if (url.pathname === '/api/key') {
      const user = await store.verifyToken((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
      if (!user) return json(res, 401, { error: 'Sign in again.' });
      if (req.method === 'DELETE') { await store.deleteKey(user.id); return json(res, 200, { ok: true }); }
      if (req.method === 'POST') {
        const key = String((await readBody(req)).key ?? '').trim();
        if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) return json(res, 400, { error: 'That does not look like an Anthropic API key.' });
        await store.setKey(user.id, key);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'Use POST or DELETE.' });
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

new Hub({ store, makeLlm, config, traceDir: env.SWARM_TRACE_DIR ?? null, log: (...a) => console.error(...a) }).listen(server);
const port = Number(env.PORT ?? 8787);
server.listen(port, () => console.log(`Senju server on http://localhost:${port}`));
