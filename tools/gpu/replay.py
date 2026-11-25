#!/usr/bin/env python3
"""Replay requests recorded by record.mjs against a vLLM server and measure speculative decoding on them.

    REPLAY_FILE=record.jsonl REPLAY_TEMP=worker02 python3 tools/gpu/replay.py BASE_URL KEY LABEL [N]

REPLAY_TEMP: greedy (temperature 0), worker02 (what Senju sends Ripple: workers 0.2, the lead the endpoint
default), default (no temperature), recorded (as sent). Runs the requests one at a time, then 4 at once, and
reads tokens accepted per draft from vLLM's /metrics. Appends a summary to replay_results.jsonl.
"""
import json, re, sys, time, threading, urllib.request, statistics as st, pathlib
BASE, KEY, LABEL = sys.argv[1].rstrip('/'), sys.argv[2], sys.argv[3]
N = int(sys.argv[4]) if len(sys.argv) > 4 else 60
H = {'Authorization': 'Bearer ' + KEY, 'content-type': 'application/json'}
here = pathlib.Path(__file__).parent
import os
recs = [json.loads(l) for l in open(os.environ.get('REPLAY_FILE', here / 'record.jsonl'))]
# keep a spread: every k-th record, in recorded order
k = max(1, len(recs) // N); recs = recs[::k][:N]

def metrics():
    t = urllib.request.urlopen(urllib.request.Request(BASE.removesuffix('/v1') + '/metrics', headers=H), timeout=30).read().decode()
    g = lambda n: sum(float(x) for x in re.findall(rf'^vllm:spec_decode_{n}_total\{{[^}}]*\}} ([0-9.e+]+)', t, re.M))
    return {'drafts': g('num_drafts'), 'draft_tokens': g('num_draft_tokens'), 'accepted': g('num_accepted_tokens')}

def once(rec):
    import os
    mode = os.environ.get('REPLAY_TEMP', 'greedy')   # greedy: 0; recorded: as the app sent it; default: endpoint default
    body = dict(rec['body'], stream=True, stream_options={'include_usage': True})
    if mode == 'greedy': body['temperature'] = 0
    elif mode == 'default': body.pop('temperature', None)
    elif mode == 'worker02':   # what Senju now sends: workers 0.2, the lead the endpoint default
        is_lead = any(t.get('function', {}).get('name') == 'spawn_agent' for t in rec['body'].get('tools', []))
        body.pop('temperature', None)
        if not is_lead: body['temperature'] = 0.2
    body.pop('top_p', None)
    t0 = time.time(); first = None; usage = None
    r = urllib.request.urlopen(urllib.request.Request(BASE + '/chat/completions', data=json.dumps(body).encode(), headers=H), timeout=900)
    for line in r:
        line = line.decode().strip()
        if not line.startswith('data: ') or line == 'data: [DONE]': continue
        d = json.loads(line[6:])
        if d.get('usage'): usage = d['usage']
        if first is None and d.get('choices') and any(d['choices'][0].get('delta', {}).get(x) for x in ('content', 'reasoning_content', 'reasoning', 'tool_calls')): first = time.time() - t0
    tot = time.time() - t0; n = usage['completion_tokens']
    lead = any(t.get('function', {}).get('name') == 'spawn_agent' for t in rec['body'].get('tools', []))
    return {'role': 'lead' if lead else 'worker', 'total': tot, 'ttft': first or tot, 'out': n, 'tps': (n - 1) / max(tot - (first or 0), 1e-3)}

def run_seq(rs): return [once(r) for r in rs]
def run_par(rs, k=4):
    out = []
    for i in range(0, len(rs), k):
        chunk = rs[i:i + k]; res = [None] * len(chunk)
        ths = [threading.Thread(target=lambda j=j: res.__setitem__(j, once(chunk[j]))) for j in range(len(chunk))]
        [t.start() for t in ths]; [t.join() for t in ths]; out += res
    return out

def summ(rs, wall):
    d = {'n': len(rs), 'wall_s': round(wall, 1), 'out_tokens': sum(r['out'] for r in rs), 'tok_per_s_overall': round(sum(r['out'] for r in rs) / wall, 1)}
    for role in ('worker', 'lead'):
        x = [r for r in rs if r['role'] == role]
        if x: d[role] = {'n': len(x), 'median_tps': round(st.median(r['tps'] for r in x), 1), 'median_total_s': round(st.median(r['total'] for r in x), 2)}
    return d

once(recs[0])  # warm
res = {'label': LABEL, 'requests': len(recs)}
m0 = metrics(); t = time.time(); s = run_seq(recs); res['seq'] = summ(s, time.time() - t); m1 = metrics()
t = time.time(); p = run_par(recs); res['par4'] = summ(p, time.time() - t)
d = {x: m1[x] - m0[x] for x in m0}
if d['drafts']: res['accept_len_seq'] = round(1 + d['accepted'] / d['drafts'], 2); res['accept_rate_seq'] = round(d['accepted'] / max(d['draft_tokens'], 1), 3)
print(json.dumps(res, indent=1))
open(here / 'replay_results.jsonl', 'a').write(json.dumps(res) + '\n')
