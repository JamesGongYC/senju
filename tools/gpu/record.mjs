// Recording proxy: Senju's real requests, for replay.py and for drafter training data. Forwards OpenAI-style requests
// to TARGET (a vLLM server), asks for token ids (return_token_ids), and appends { body, prompt_ids, output_ids, usage }
// per chat completion to OUT (jsonl).
//   TARGET=https://<...>.modal.run/v1 OUT=record.jsonl node tools/gpu/record.mjs 8811
// then set the ripple-gpu provider's baseURL to http://127.0.0.1:8811/v1 and run jobs.
// The file holds whatever the agents saw (page text, messages), so keep it private.
import http from 'node:http';
import fs from 'node:fs';
const target = process.env.TARGET.replace(/\/+$/, '');
const out = process.env.OUT ?? 'record.jsonl';
http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const isChat = req.url.endsWith('/chat/completions') && req.method === 'POST';
  let sent = body;
  if (isChat) { const b = JSON.parse(body); b.return_token_ids = true; sent = JSON.stringify(b); }
  const r = await fetch(target + req.url.replace(/^\/v1/, ''), { method: req.method, headers: { 'content-type': 'application/json', authorization: req.headers.authorization ?? '' }, body: req.method === 'POST' ? sent : undefined });
  const text = await r.text();
  if (isChat && r.ok) {
    try {
      const j = JSON.parse(text);
      fs.appendFileSync(out, JSON.stringify({ t: Date.now(), body: JSON.parse(body), prompt_ids: j.prompt_token_ids ?? null, output_ids: j.choices?.[0]?.token_ids ?? null, usage: j.usage }) + '\n');
    } catch { /* not JSON: pass through unrecorded */ }
  }
  res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(text);
}).listen(Number(process.argv[2] ?? 8811), '127.0.0.1', () => console.log('recording to', out));
